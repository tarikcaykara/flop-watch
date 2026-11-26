import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RpcHeader } from "../src/babe.ts";
import { PROFILES } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { createMetrics, type Metrics } from "../src/metrics.ts";
import {
	EXPLORER_INTERVAL_MS,
	FAUCET_INTERVAL_MS,
	GENESIS_INTERVAL_MS,
	type ProbeLoop,
	RETRY_AFTER_CAP_MS,
	RPC_HTTP_INTERVAL_MS,
	startExplorerProbe,
	startFaucetProbes,
	startHttpRpcProbes,
	startLoop,
} from "../src/probes.ts";
import {
	eventually,
	type ManualClock,
	manualClock,
	REMOVE,
	sample,
	serviceBody,
	withField,
} from "./helpers.ts";

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

	it("keeps the first run within the 5 s jitter window", () => {
		runLoop(recordingRun, 0.9999);
		clock.advance(4_998);
		assert.deepEqual(starts, []);
		clock.advance(1);
		assert.deepEqual(starts, [4_999]);
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

	it("reports a genesis mismatch, and keeps the last value when a later check fails", async () => {
		results["chain_getBlockHash"] = PROFILES.devnet.expectedGenesis;
		try {
			startProbes();
			await eventually(
				async () => (await sample(metrics.genesisMatch, { source: "rpc_http" })) === 0,
				"mismatch",
			);
			await settle();
			answer = (method, res) =>
				method === "chain_getBlockHash" ? res.writeHead(502).end() : healthy(method, res);
			clock.advance(GENESIS_INTERVAL_MS);
			await eventually(
				() => received.filter((m) => m === "chain_getBlockHash").length === 2,
				"recheck",
			);
			await settle();
			assert.equal(
				await sample(metrics.genesisMatch, { source: "rpc_http" }),
				0,
				"kept, alert keeps firing",
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

	it("treats a 503 with Retry-After as http_error, but still waits before the next request", async () => {
		answer = (method, res) =>
			method === "chain_getHeader"
				? res.writeHead(503, { "retry-after": "90" }).end("busy")
				: healthy(method, res);
		startProbes();
		await eventually(
			async () => (await sample(metrics.probeTotal, { ...target, result: "http_error" })) === 1,
			"503",
		);
		await settle();
		assert.equal(received.filter((m) => m === "system_health").length, 0, "no second request");
		clock.advance(60_000);
		await settle();
		assert.equal(received.filter((m) => m === "chain_getHeader").length, 1);
		clock.advance(30_000);
		await eventually(
			() => received.filter((m) => m === "chain_getHeader").length === 2,
			"after 90 s",
		);
	});

	it("pauses both loops when either is told to wait", async () => {
		answer = (method, res) =>
			method === "chain_getBlockHash"
				? res.writeHead(429, { "retry-after": "120" }).end()
				: healthy(method, res);
		startProbes();
		await eventually(
			async () => (await sample(metrics.probeTotal, { ...target, result: "rate_limited" })) === 1,
			"genesis rate limited",
		);
		await eventually(async () => (await sample(metrics.probeSuccess, target)) === 1, "first cycle");
		await settle();
		clock.advance(RPC_HTTP_INTERVAL_MS);
		await settle();
		assert.equal(received.filter((m) => m === "chain_getHeader").length, 1, "paused at 30 s");
		clock.advance(120_000 - RPC_HTTP_INTERVAL_MS);
		await eventually(() => received.filter((m) => m === "chain_getHeader").length === 2, "resumed");
	});
});

describe("faucet and explorer probes", () => {
	interface Answer {
		readonly status: number;
		/** A string is sent as is; anything else as JSON. */
		readonly body: unknown;
		readonly headers?: Record<string, string>;
	}
	const requests: Array<{ method: string | undefined; path: string; userAgent: string }> = [];
	let answers: Record<string, Answer> = {};
	const server = createServer((req, res) => {
		const path = req.url ?? "";
		requests.push({ method: req.method, path, userAgent: req.headers["user-agent"] ?? "" });
		const answer = answers[path];
		if (answer === undefined) {
			res.writeHead(404).end();
			return;
		}
		res
			.writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
			.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
	});
	let url = "";
	let clock: ManualClock;
	let metrics: Metrics;
	let probes: ProbeLoop | undefined;

	const devnetAnswers = (): Record<string, Answer> => ({
		"/limits": { status: 200, body: serviceBody("devnet", "faucet_limits", 200) },
		"/health": { status: 200, body: serviceBody("devnet", "faucet_health", 200) },
		"/chain": { status: 200, body: serviceBody("devnet", "faucet_chain", 200) },
	});
	const testnetAnswers = (): Record<string, Answer> => ({
		"/limits": { status: 200, body: serviceBody("testnet", "faucet_limits", 200) },
		"/health": {
			status: 503,
			body: serviceBody("testnet", "faucet_health", 503),
			headers: { "retry-after": "60" },
		},
		"/chain": { status: 200, body: serviceBody("testnet", "faucet_chain", 200) },
	});
	const startProbes = (network: "devnet" | "testnet") => {
		probes = startFaucetProbes({
			network: PROFILES[network],
			faucetUrl: url,
			metrics,
			log: silent,
			schedule: clock.schedule,
			now: clock.now,
			random: () => 0,
		});
		clock.advance(0);
	};
	/** Waits until `n` requests have been recorded, then lets the loops reschedule. */
	const recorded = async (n: number) => {
		await eventually(async () => {
			const { values } = await metrics.probeTotal.get();
			return values.reduce((sum, v) => sum + v.value, 0) === n;
		}, `${n} requests recorded`);
		await settle();
	};
	const count = (path: string) => requests.filter((r) => r.path === path).length;

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
		requests.length = 0;
		clock = manualClock();
		metrics = createMetrics({ defaultMetrics: false });
	});

	it("GETs /limits, /health and /chain every 60 s and exports what they report (open)", async () => {
		answers = devnetAnswers();
		startProbes("devnet");
		await recorded(3);
		assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`).toSorted(), [
			"GET /chain",
			"GET /health",
			"GET /limits",
		]);
		for (const { userAgent } of requests) assert.match(userAgent, /^flop-watch\//);
		for (const target of ["faucet_limits", "faucet_health", "faucet_chain"]) {
			assert.equal(await sample(metrics.probeSuccess, { target }), 1, target);
			assert.ok(((await sample(metrics.probeLastSuccess, { target })) ?? 0) > 0, target);
		}

		assert.equal(await sample(metrics.faucetStatus, { status: "open" }), 1);
		assert.equal(await sample(metrics.faucetStatus, { status: "unknown" }), 0);
		assert.equal(await sample(metrics.faucetStale), 0);
		assert.equal(
			await sample(metrics.faucetLimitsAsOf),
			Date.parse("2026-11-25T19:00:09.361Z") / 1000,
		);
		assert.equal(await sample(metrics.faucetBalance), 30482522);
		assert.equal(await sample(metrics.faucetMinBalance), 10000000);
		assert.equal(await sample(metrics.faucetDailyCapLimit), 10000000);
		assert.equal(await sample(metrics.faucetDailyCapUsed), 3323710);
		assert.equal(await sample(metrics.faucetDailyCapRemaining), 6676290);
		assert.equal(await sample(metrics.faucetPendingGrants), 0);
		const sponsor = (lane: string, status: string) =>
			sample(metrics.faucetSponsorStatus, { lane, status });
		assert.equal(await sponsor("miner", "positions_full"), 1);
		assert.equal(await sponsor("miner", "open"), 0);
		assert.equal(await sponsor("validator", "open"), 1);

		assert.equal(await sample(metrics.faucetHealthReady), 0);
		assert.equal(await sample(metrics.faucetHealthStatusCode), 200);
		const dependency = (name: string) => sample(metrics.faucetDependencyOk, { dependency: name });
		assert.equal(await dependency("signer"), 1);
		assert.equal(await dependency("funding"), 0);
		assert.equal(await dependency("signing"), undefined, "signing has no ok");
		assert.equal(await sample(metrics.faucetIndexerLag), 2);

		assert.equal(await sample(metrics.genesisMatch, { source: "faucet" }), 1);
		assert.deepEqual((await metrics.schemaMismatch.get()).values, []);

		clock.advance(FAUCET_INTERVAL_MS - 1);
		await settle();
		assert.equal(requests.length, 3, "nothing before 60 s");
		clock.advance(1);
		await recorded(6);
		assert.deepEqual([count("/limits"), count("/health"), count("/chain")], [2, 2, 2]);
	});

	it("reports faucet.status low_balance", async () => {
		const limits = withField(
			serviceBody("devnet", "faucet_limits", 200),
			"faucet.status",
			"low_balance",
		);
		answers = { ...devnetAnswers(), "/limits": { status: 200, body: limits } };
		startProbes("devnet");
		await recorded(3);
		assert.equal(await sample(metrics.faucetStatus, { status: "low_balance" }), 1);
		assert.equal(await sample(metrics.faucetStatus, { status: "open" }), 0);
	});

	it("reports the unknown shape: faucet and both sponsor lanes unknown", async () => {
		// The shape seen with faucet.status "unknown" (research §6).
		let limits = withField(serviceBody("devnet", "faucet_limits", 200), "faucet.status", "unknown");
		for (const lane of ["miner", "validator"]) {
			limits = withField(limits, `sponsor.${lane}`, {
				status: "unknown",
				reason: "sponsor_unavailable",
			});
		}
		answers = { ...devnetAnswers(), "/limits": { status: 200, body: limits } };
		startProbes("devnet");
		await recorded(3);
		assert.equal(await sample(metrics.faucetStatus, { status: "unknown" }), 1);
		assert.equal(await sample(metrics.faucetStatus, { status: "open" }), 0);
		for (const lane of ["miner", "validator"]) {
			assert.equal(await sample(metrics.faucetSponsorStatus, { lane, status: "unknown" }), 1);
			assert.equal(await sample(metrics.faucetSponsorStatus, { lane, status: "open" }), 0);
		}
		assert.equal(await sample(metrics.faucetBalance), 30482522);
		assert.deepEqual((await metrics.schemaMismatch.get()).values, []);
	});

	it("takes a 503 /health with Retry-After: 60 as a valid answer that pauses nothing", async () => {
		answers = testnetAnswers();
		startProbes("testnet");
		await recorded(3);
		assert.equal(await sample(metrics.probeTotal, { target: "faucet_health", result: "ok" }), 1);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_health" }), 1);
		assert.equal(await sample(metrics.faucetHealthStatusCode), 503);
		assert.equal(await sample(metrics.faucetHealthReady), 0);
		assert.equal(await sample(metrics.faucetDependencyOk, { dependency: "indexer" }), 0);
		assert.equal(await sample(metrics.faucetDependencyOk, { dependency: "signer" }), 1);
		assert.equal(await sample(metrics.faucetIndexerLag), undefined);

		clock.advance(FAUCET_INTERVAL_MS);
		await recorded(6);
		assert.deepEqual([count("/limits"), count("/health"), count("/chain")], [2, 2, 2]);
	});

	it("fails /chain on a 503 and keeps the faucet genesis match", async () => {
		answers = testnetAnswers();
		startProbes("testnet");
		await recorded(3);
		assert.equal(await sample(metrics.genesisMatch, { source: "faucet" }), 1);

		answers["/chain"] = { status: 503, body: serviceBody("testnet", "faucet_chain", 503) };
		clock.advance(FAUCET_INTERVAL_MS);
		await recorded(6);
		assert.equal(
			await sample(metrics.probeTotal, { target: "faucet_chain", result: "http_error" }),
			1,
		);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_chain" }), 0);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_limits" }), 1);
		assert.equal(await sample(metrics.genesisMatch, { source: "faucet" }), 1, "identity kept");
		assert.deepEqual((await metrics.schemaMismatch.get()).values, [], "error body not parsed");
	});

	it("reports a faucet on another chain as a genesis mismatch", async () => {
		answers = devnetAnswers();
		startProbes("testnet");
		await recorded(3);
		assert.equal(await sample(metrics.genesisMatch, { source: "faucet" }), 0);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_chain" }), 1);
	});

	it("drops a target's values when its request fails, and keeps its last success time", async () => {
		answers = devnetAnswers();
		startProbes("devnet");
		await recorded(3);
		const lastSuccess = await sample(metrics.probeLastSuccess, { target: "faucet_limits" });

		answers = {
			...answers,
			"/limits": { status: 502, body: "<html>bad gateway</html>" },
			"/health": { status: 502, body: { error: "bad gateway" } },
		};
		clock.advance(FAUCET_INTERVAL_MS);
		await recorded(6);
		assert.equal(
			await sample(metrics.probeTotal, { target: "faucet_limits", result: "http_error" }),
			1,
		);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_limits" }), 0);
		assert.equal(await sample(metrics.probeLastSuccess, { target: "faucet_limits" }), lastSuccess);
		assert.equal(await sample(metrics.faucetStatus), undefined);
		assert.equal(await sample(metrics.faucetStale), undefined);
		assert.equal(await sample(metrics.faucetLimitsAsOf), undefined);
		assert.equal(await sample(metrics.faucetBalance), undefined);
		assert.equal(await sample(metrics.faucetSponsorStatus), undefined);

		assert.equal(
			await sample(metrics.probeTotal, { target: "faucet_health", result: "http_error" }),
			1,
			"a JSON 502 is no /health answer",
		);
		assert.equal(await sample(metrics.faucetHealthStatusCode), 502, "measured on failures too");
		assert.equal(await sample(metrics.faucetHealthReady), undefined);
		assert.equal(await sample(metrics.faucetDependencyOk), undefined);
		assert.equal(await sample(metrics.faucetIndexerLag), undefined);
	});

	it("drops a missing field's series and counts it; /chain without a genesis fails", async () => {
		let limits = withField(
			serviceBody("devnet", "faucet_limits", 200),
			"faucet.balanceFlop",
			REMOVE,
		);
		limits = withField(limits, "sponsor.validator.status", 5);
		answers = {
			...devnetAnswers(),
			"/limits": { status: 200, body: limits },
			"/chain": {
				status: 200,
				body: withField(serviceBody("devnet", "faucet_chain", 200), "genesisHash", "0xABC"),
			},
		};
		startProbes("devnet");
		await recorded(3);
		const mismatch = (target: string, field: string) =>
			sample(metrics.schemaMismatch, { target, field });
		assert.equal(await mismatch("faucet_limits", "faucet.balanceFlop"), 1);
		assert.equal(await sample(metrics.faucetBalance), undefined);
		assert.equal(await sample(metrics.faucetMinBalance), 10000000);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_limits" }), 1);
		assert.equal(await mismatch("faucet_limits", "sponsor.validator.status"), 1);
		assert.equal(await sample(metrics.faucetSponsorStatus, { lane: "validator" }), undefined);
		assert.equal(
			await sample(metrics.faucetSponsorStatus, { lane: "miner", status: "positions_full" }),
			1,
			"the other lane stays",
		);

		assert.equal(await mismatch("faucet_chain", "genesisHash"), 1);
		assert.equal(
			await sample(metrics.probeTotal, { target: "faucet_chain", result: "invalid_response" }),
			1,
		);
		assert.equal(await sample(metrics.probeSuccess, { target: "faucet_chain" }), 0);
		assert.equal(await sample(metrics.genesisMatch, { source: "faucet" }), undefined);
	});

	it("pauses all three probes for a Retry-After on any of them", async () => {
		answers = {
			...devnetAnswers(),
			"/limits": { status: 429, body: "", headers: { "retry-after": "120" } },
		};
		startProbes("devnet");
		await recorded(3);
		assert.equal(
			await sample(metrics.probeTotal, { target: "faucet_limits", result: "rate_limited" }),
			1,
		);

		answers = devnetAnswers();
		clock.advance(FAUCET_INTERVAL_MS);
		await settle();
		assert.equal(requests.length, 3, "paused at 60 s");
		clock.advance(120_000 - FAUCET_INTERVAL_MS);
		await recorded(6);
		assert.deepEqual([count("/limits"), count("/health"), count("/chain")], [2, 2, 2]);
	});

	describe("explorer /api/stats", () => {
		const stats = (status: 200 | 503, body: unknown) => ({ "/api/stats": { status, body } });
		const startExplorer = () => {
			probes = startExplorerProbe({
				network: PROFILES.devnet,
				explorerApiUrl: `${url}/api`,
				metrics,
				log: silent,
				schedule: clock.schedule,
				now: clock.now,
				random: () => 0,
			});
			clock.advance(0);
		};

		it("GETs <explorer API>/stats every 60 s and exports what it reports", async () => {
			answers = stats(200, serviceBody("devnet", "explorer_stats", 200));
			startExplorer();
			await recorded(1);
			assert.deepEqual(
				requests.map((r) => `${r.method} ${r.path}`),
				["GET /api/stats"],
			);
			assert.equal(await sample(metrics.probeSuccess, { target: "explorer_stats" }), 1);
			assert.equal(await sample(metrics.explorerLatestBlock), 4637408);
			assert.equal(await sample(metrics.explorerFinalizedLag), 5);
			assert.equal(await sample(metrics.explorerSafeMode), 0);
			assert.deepEqual((await metrics.schemaMismatch.get()).values, []);

			clock.advance(EXPLORER_INTERVAL_MS - 1);
			await settle();
			assert.equal(requests.length, 1, "nothing before 60 s");
			clock.advance(1);
			await recorded(2);
		});

		it("records the Testnet 503 as http_error and drops the explorer values", async () => {
			answers = stats(200, serviceBody("devnet", "explorer_stats", 200));
			startExplorer();
			await recorded(1);
			const lastSuccess = await sample(metrics.probeLastSuccess, { target: "explorer_stats" });

			answers = stats(503, serviceBody("testnet", "explorer_stats", 503));
			clock.advance(EXPLORER_INTERVAL_MS);
			await recorded(2);
			assert.equal(
				await sample(metrics.probeTotal, { target: "explorer_stats", result: "http_error" }),
				1,
			);
			assert.equal(await sample(metrics.probeSuccess, { target: "explorer_stats" }), 0);
			assert.equal(
				await sample(metrics.probeLastSuccess, { target: "explorer_stats" }),
				lastSuccess,
			);
			assert.equal(await sample(metrics.explorerLatestBlock), undefined);
			assert.equal(await sample(metrics.explorerFinalizedLag), undefined);
			assert.equal(await sample(metrics.explorerSafeMode), undefined);
			assert.deepEqual((await metrics.schemaMismatch.get()).values, [], "error body not parsed");
		});

		it("drops a retyped field's series and counts it, and the probe stays ok", async () => {
			const body = withField(
				serviceBody("devnet", "explorer_stats", 200),
				"finality.safeMode",
				"no",
			);
			answers = stats(200, body);
			startExplorer();
			await recorded(1);
			assert.equal(
				await sample(metrics.schemaMismatch, {
					target: "explorer_stats",
					field: "finality.safeMode",
				}),
				1,
			);
			assert.equal(await sample(metrics.explorerSafeMode), undefined);
			assert.equal(await sample(metrics.explorerLatestBlock), 4637408);
			assert.equal(await sample(metrics.probeSuccess, { target: "explorer_stats" }), 1);
		});
	});
});

describe("read-only source (hard rule 1)", () => {
	const dir = new URL("../src/", import.meta.url);
	const sources = readdirSync(dir, { encoding: "utf8", recursive: true })
		.filter((file) => file.endsWith(".ts"))
		.map((file) => [file, readFileSync(new URL(file, dir), "utf8")] as const);

	it("contains no faucet claim or other write path", () => {
		assert.ok(sources.some(([file]) => file === "probes.ts"));
		for (const [file, text] of sources) {
			for (const path of [
				"agent-claims",
				"/fund",
				"/sponsor",
				"faucet/fund",
				"enroll",
				"chat/completions",
			]) {
				assert.ok(!text.includes(path), `${file} contains ${path}`);
			}
		}
	});

	it("sends POST only from the JSON-RPC client, and never PUT, PATCH or DELETE", () => {
		for (const [file, text] of sources) {
			for (const method of ["PUT", "PATCH", "DELETE"]) {
				assert.ok(!text.includes(`"${method}"`), `${file} sends ${method}`);
			}
			if (file !== "http.ts" && file !== "rpc-http.ts") {
				assert.ok(!text.includes('"POST"'), `${file} sends POST`);
			}
		}
	});
});
