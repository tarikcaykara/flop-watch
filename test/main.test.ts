import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../src/log.ts";
import { startMetricsServer } from "../src/main.ts";
import { createMetrics } from "../src/metrics.ts";
import { VERSION } from "../src/version.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

function portOf(server: { address(): unknown }): number {
	const address = server.address();
	assert.ok(address && typeof address === "object" && "port" in address);
	assert.equal(typeof address.port, "number");
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

/** Runs the collector as a real process with only the given FLOPWATCH_* variables. */
function runCollector(env: Record<string, string>): ChildProcess {
	return spawn(process.execPath, [MAIN], {
		env: { PATH: process.env["PATH"] ?? "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function readUntil(child: ChildProcess, pattern: RegExp): Promise<string> {
	let output = "";
	assert.ok(child.stdout);
	for await (const chunk of child.stdout) {
		output += String(chunk);
		if (pattern.test(output)) return output;
	}
	throw new Error(`process ended before ${pattern}: ${output}`);
}

describe("metrics server", () => {
	let base = "";
	let close = () => {};

	before(async () => {
		const server = await startMetricsServer({
			host: "127.0.0.1",
			port: 0,
			metrics: createMetrics({ defaultMetrics: false }),
			log: createLogger("error", () => {}),
		});
		base = `http://127.0.0.1:${portOf(server)}`;
		close = () => server.close();
	});
	after(() => close());

	it("serves the Prometheus text format on /metrics", async () => {
		const res = await fetch(`${base}/metrics`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
		assert.match(
			await res.text(),
			new RegExp(`^flopwatch_build_info\\{version="${VERSION}"\\} 1$`, "m"),
		);
	});

	it("answers /healthz, and 404 or 405 for anything else", async () => {
		assert.equal((await fetch(`${base}/healthz`)).status, 200);
		assert.equal((await fetch(`${base}/nope`)).status, 404);
		assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 405);
	});
});

describe("collector process", () => {
	it("exits with 1 and lists the problem on an invalid configuration", async () => {
		const child = runCollector({ FLOPWATCH_PORT: "0" });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const [code] = await once(child, "exit");
		assert.equal(code, 1);
		assert.match(stderr, /FLOPWATCH_PORT: expected an integer 1-65535/);
	});

	it("serves metrics, then exits with 0 within 5 s of SIGTERM", async () => {
		const port = await freePort();
		const child = runCollector({ FLOPWATCH_HOST: "127.0.0.1", FLOPWATCH_PORT: String(port) });
		await readUntil(child, /"msg":"flop-watch started"/);
		assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);

		const exited = once(child, "exit");
		const started = Date.now();
		child.kill("SIGTERM");
		const [code] = await exited;
		assert.equal(code, 0);
		assert.ok(Date.now() - started < 5_000);
	});
});
