import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, type Server } from "node:net";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/log.ts";
import { startMetricsServer } from "../src/main.ts";
import { createMetrics } from "../src/metrics.ts";
import { VERSION } from "../src/version.ts";
import { eventually } from "./helpers.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

function portOf(server: { address(): unknown }): number {
	const address = server.address();
	assert.ok(address && typeof address === "object" && "port" in address);
	return Number(address.port);
}

async function freePort(): Promise<number> {
	const probe: Server = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = portOf(probe);
	probe.close();
	await once(probe, "close");
	return port;
}

/** Sends a raw HTTP/1.1 request line, bypassing fetch's URL validation, and returns the reply. */
async function rawRequest(port: number, target: string): Promise<string> {
	const socket = connect(port, "127.0.0.1");
	await once(socket, "connect");
	socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
	let reply = "";
	for await (const chunk of socket) reply += String(chunk);
	return reply;
}

interface Collector {
	readonly child: ChildProcess;
	/** Resolves on the "started" log line; rejects if the process exits first. */
	readonly started: Promise<void>;
	readonly output: () => string;
}

/** Runs the collector as a real process with only the given FLOPWATCH_* variables. */
function runCollector(env: Record<string, string>): Collector {
	const child = spawn(process.execPath, [MAIN], {
		env: { PATH: process.env["PATH"] ?? "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const { promise: started, resolve, reject } = Promise.withResolvers<void>();
	started.catch(() => {}); // awaited only by tests that expect a start
	const onData = (chunk: unknown) => {
		output += String(chunk);
		if (output.includes('"msg":"flop-watch started"')) resolve();
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.once("exit", (code) => reject(new Error(`exited with ${code} before starting: ${output}`)));
	return { child, started, output: () => output };
}

describe("metrics server", () => {
	let port = 0;
	let close = () => {};

	before(async () => {
		const server = await startMetricsServer({
			host: "127.0.0.1",
			port: 0,
			metrics: createMetrics({ defaultMetrics: false }),
			log: createLogger("error", () => {}),
		});
		port = portOf(server);
		close = () => {
			server.closeAllConnections();
			server.close();
		};
	});
	after(() => close());

	it("serves the Prometheus text format on /metrics, with or without a query string", async () => {
		for (const path of ["/metrics", "/metrics?x=1"]) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`);
			assert.equal(res.status, 200);
			assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
			assert.match(
				await res.text(),
				new RegExp(`^flopwatch_build_info\\{version="${VERSION}"\\} 1$`, "m"),
			);
		}
	});

	it("answers /healthz, and 404 or 405 for anything else", async () => {
		const base = `http://127.0.0.1:${port}`;
		assert.equal((await fetch(`${base}/healthz`)).status, 200);
		assert.equal((await fetch(`${base}/nope`)).status, 404);
		assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 405);
	});

	it("survives a malformed request target", async () => {
		assert.match(await rawRequest(port, "//"), /^HTTP\/1\.1 404/);
		assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
	});
});

describe("collector process", () => {
	it("exits with 1 and lists the problem on an invalid configuration", {
		timeout: 15_000,
	}, async () => {
		const { child, output } = runCollector({ FLOPWATCH_PORT: "0" });
		try {
			const [code] = await once(child, "exit");
			assert.equal(code, 1);
			assert.match(output(), /FLOPWATCH_PORT: expected an integer 1-65535/);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("runs a worker per network, serves metrics, then exits with 0 within 5 s of SIGTERM", {
		timeout: 20_000,
	}, async () => {
		const port = await freePort();
		const unreachable = await freePort(); // closed: the workers fail fast, nothing leaves the host
		const { child, started: ready } = runCollector({
			FLOPWATCH_HOST: "127.0.0.1",
			FLOPWATCH_PORT: String(port),
			FLOPWATCH_NETWORKS: "testnet",
			FLOPWATCH_TESTNET_RPC_WS: `ws://127.0.0.1:${unreachable}`,
			FLOPWATCH_TESTNET_RPC_HTTP: `http://127.0.0.1:${unreachable}`,
			FLOPWATCH_TESTNET_FAUCET_URL: "",
			FLOPWATCH_TESTNET_EXPLORER_API_URL: "",
		});
		try {
			await ready;
			assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
			const series = (target: string) =>
				`flopwatch_probe_total{network="testnet",target="${target}",result="network_error"}`;
			const scrape = async () => (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
			// The HTTP probes start after up to 5 s of jitter; a closed port fails at once.
			await eventually(
				async () => {
					const body = await scrape();
					return body.includes(series("rpc_ws")) && body.includes(series("rpc_http"));
				},
				"chain watcher and HTTP probes running",
				8_000,
			);

			const exited = once(child, "exit");
			const started = Date.now();
			child.kill("SIGTERM");
			const [code] = await exited;
			assert.equal(code, 0);
			assert.ok(Date.now() - started < 5_000);
		} finally {
			child.kill("SIGKILL");
		}
	});
});
