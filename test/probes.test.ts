import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RpcHeader } from "../src/babe.ts";
import { PROFILES } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { createMetrics, type Metrics } from "../src/metrics.ts";
import {
	GENESIS_INTERVAL_MS,
	type ProbeLoop,
	RETRY_AFTER_CAP_MS,
	RPC_HTTP_INTERVAL_MS,
	startHttpRpcProbes,
	startLoop,
} from "../src/probes.ts";
import { eventually, type ManualClock, manualClock, sample } from "./helpers.ts";

const silent = createLogger("error", () => {});
/** Lets the promise continuations of a finished run (rescheduling, metric writes) happen. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("startLoop", () => {
	let clock: ManualClock;
	let loop: ProbeLoop | undefined;
	const starts: number[] = [];

	const runLoop = (run: () => Promise<number | null>, random = 0.5) => {
		loop = startLoop("test", 30_000, run, {
			log: silent,
			schedule: clock.schedule,
			now: clock.now,
			random: () => random,
		});
	};
	const recordingRun = async () => {
		starts.push(clock.now());
		return null;
	};

	beforeEach(async () => {
		await loop?.stop();
		loop = undefined;
		clock = manualClock();
		starts.length = 0;
	});

	it("starts after a 0–5 s jitter and then runs every interval", async () => {
		runLoop(recordingRun);
		clock.advance(2_499);
		assert.deepEqual(starts, []);
		clock.advance(1); // random 0.5 × 5 s
		await settle();
		clock.advance(30_000);
		await settle();
		clock.advance(30_000);
		assert.deepEqual(starts, [2_500, 32_500, 62_500]);
	});

	it("never overlaps: a run that outlasts the interval skips the missed slots", async () => {
		const { promise: slowRun, resolve: finishSlowRun } = Promise.withResolvers<number | null>();
		let calls = 0;
		runLoop(() => {
			starts.push(clock.now());
			return ++calls === 1 ? slowRun : Promise.resolve(null);
		}, 0);
		clock.advance(0);
		clock.advance(70_000); // the first run is still in flight
		assert.deepEqual(starts, [0]);
		finishSlowRun(null);
		await settle();
		clock.advance(19_999);
		assert.deepEqual(starts, [0]);
		clock.advance(1); // next slot at 90 s; 30 s and 60 s were skipped
		assert.deepEqual(starts, [0, 90_000]);
	});

	it("waits for Retry-After, capped at 10 min", async () => {
		const waits = [120_000, 3_600_000, null];
		runLoop(async () => {
			starts.push(clock.now());
			return waits.shift() ?? null;
		}, 0);
		clock.advance(0);
		await settle();
		clock.advance(119_999);
		assert.deepEqual(starts, [0]);
		clock.advance(1);
		await settle();
		clock.advance(RETRY_AFTER_CAP_MS);
		await settle();
		assert.deepEqual(starts, [0, 120_000, 120_000 + RETRY_AFTER_CAP_MS]);
	});

	it("keeps running after a run throws, and stops for good", async () => {
		runLoop(async () => {
			starts.push(clock.now());
			throw new Error("boom");
		}, 0);
		clock.advance(0);
		await settle();
		clock.advance(30_000);
		await settle();
		assert.deepEqual(starts, [0, 30_000]);
		await loop?.stop();
		clock.advance(300_000);
		assert.deepEqual(starts, [0, 30_000]);
	});
});

interface Fixtures {
	networks: Record<string, { headers: Array<{ header: RpcHeader }> }>;
}
const fixtures: Fixtures = JSON.parse(
	readFileSync(new URL("fixtures/headers.json", import.meta.url), "utf8"),
);
const HEADER = fixtures.networks["testnet"]?.headers[0]?.header;
assert.ok(HEADER);

describe("startHttpRpcProbes", () => {
	const received: string[] = [];
	let answer: (method: string, res: ServerResponse) => void;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += String(chunk);
		const { id, method } = JSON.parse(raw);
		received.push(method);
		answer(method, res);
		void id;
	});
	let url = "";
	let clock: ManualClock;
	let metrics: Metrics;
	let probes: ProbeLoop | undefined;

	const results: Record<string, unknown> = {
		chain_getHeader: HEADER,
		system_health: { peers: 9, isSyncing: false, shouldHavePeers: true },
		chain_getBlockHash: PROFILES.testnet.expectedGenesis,
	};
	const healthy = (method: string, res: ServerResponse) =>
		res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: results[method] }));
	const target = { target: "rpc_http" };
	const net = { network: "testnet" };

	const startProbes = () => {
		probes = startHttpRpcProbes({
			network: { ...PROFILES.testnet, rpcHttp: url },
			metrics,
			log: silent,
			schedule: clock.schedule,
			now: clock.now,
			random: () => 0,
		});
		clock.advance(0);
	};

	before(async () => {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address === "object");
		url = `http://127.0.0.1:${address.port}`;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});
	beforeEach(async () => {
		await probes?.stop();
		probes = undefined;
		received.length = 0;
		answer = healthy;
		clock = manualClock();
		metrics = createMetrics({ defaultMetrics: false });
	});

	it("probes head, health and genesis over HTTP", async () => {
		startProbes();
		await eventually(async () => (await sample(metrics.probeSuccess, target)) === 1, "probe");
		await eventually(
			async () => (await sample(metrics.genesisMatch, { source: "rpc_http" })) === 1,
			"genesis",
		);
		assert.deepEqual(received.toSorted(), [
			"chain_getBlockHash",
			"chain_getHeader",
			"system_health",
		]);
		assert.equal(await sample(metrics.probeTotal, { ...target, result: "ok" }), 3);
		assert.equal(await sample(metrics.httpBestBlock, net), 109785);
		assert.equal(await sample(metrics.nodePeers, { transport: "http" }), 9);
		assert.equal(await sample(metrics.nodeIsSyncing, { transport: "http" }), 0);
		assert.ok(((await sample(metrics.probeLastSuccess, target)) ?? 0) > 0);

		await settle(); // the finished cycle schedules the next one
		clock.advance(RPC_HTTP_INTERVAL_MS);
		await eventually(() => received.length === 5, "second cycle");
		assert.equal(
			received.filter((m) => m === "chain_getBlockHash").length,
			1,
			"genesis every 10 min",
		);
		clock.advance(GENESIS_INTERVAL_MS - RPC_HTTP_INTERVAL_MS);
		await eventually(
			() => received.filter((m) => m === "chain_getBlockHash").length === 2,
			"second genesis check",
		);
	});

	it("reports a genesis mismatch and removes the value when the answer is unusable", async () => {
		results["chain_getBlockHash"] = PROFILES.devnet.expectedGenesis;
		try {
			startProbes();
			await eventually(
				async () => (await sample(metrics.genesisMatch, { source: "rpc_http" })) === 0,
				"mismatch",
			);
		} finally {
			results["chain_getBlockHash"] = PROFILES.testnet.expectedGenesis;
		}
	});

	it("marks the probe failed and drops stale values when the node errors", async () => {
		startProbes();
		// The first cycle must finish (and schedule the next) before the clock moves.
		await eventually(async () => (await sample(metrics.probeSuccess, target)) === 1, "first cycle");
		await settle();

		answer = (_method, res) => res.writeHead(502).end("bad gateway");
		clock.advance(RPC_HTTP_INTERVAL_MS);
		await eventually(
			async () => (await sample(metrics.probeTotal, { ...target, result: "http_error" })) === 2,
			"errors",
		);
		await eventually(async () => (await sample(metrics.probeSuccess, target)) === 0, "failed");
		assert.equal(await sample(metrics.httpBestBlock, net), undefined);
		assert.equal(await sample(metrics.nodePeers, { transport: "http" }), undefined);
	});

	it("counts a malformed header as invalid_response and a schema mismatch", async () => {
		answer = (method, res) =>
			method === "chain_getHeader"
				? res
						.writeHead(200, { "content-type": "application/json" })
						.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: 5 } }))
				: healthy(method, res);
		startProbes();
		await eventually(
			async () =>
				(await sample(metrics.probeTotal, { ...target, result: "invalid_response" })) === 1,
			"invalid header",
		);
		await eventually(async () => (await sample(metrics.probeSuccess, target)) === 0, "failed");
		assert.equal(await sample(metrics.schemaMismatch, { field: "header" }), 1);
		assert.equal(await sample(metrics.httpBestBlock, net), undefined);
	});

	it("backs off on 429: no second request in the cycle, next cycle after Retry-After", async () => {
		answer = (method, res) =>
			method === "chain_getHeader"
				? res.writeHead(429, { "retry-after": "120" }).end()
				: healthy(method, res);
		startProbes();
		await eventually(
			async () => (await sample(metrics.probeTotal, { ...target, result: "rate_limited" })) === 1,
			"rate limited",
		);
		await settle();
		assert.equal(received.filter((m) => m === "system_health").length, 0);

		clock.advance(RPC_HTTP_INTERVAL_MS);
		await settle();
		assert.equal(received.filter((m) => m === "chain_getHeader").length, 1, "no request at 30 s");
		clock.advance(120_000 - RPC_HTTP_INTERVAL_MS);
		await eventually(
			() => received.filter((m) => m === "chain_getHeader").length === 2,
			"request after Retry-After",
		);
	});
});
