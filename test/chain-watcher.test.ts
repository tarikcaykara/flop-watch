import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import type { RpcHeader } from "../src/babe.ts";
import {
	BACKOFF_BASE_MS,
	type ChainWatcher,
	startChainWatcher,
	WATCHDOG_MS,
} from "../src/chain-watcher.ts";
import { PROFILES } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { createMetrics, type Metrics } from "../src/metrics.ts";

interface Fixtures {
	networks: Record<string, { babeConfiguration: string; headers: Array<{ header: RpcHeader }> }>;
}
const fixtures: Fixtures = JSON.parse(
	readFileSync(new URL("fixtures/headers.json", import.meta.url), "utf8"),
);
const testnet = fixtures.networks["testnet"];
assert.ok(testnet);
const HEADERS = testnet.headers.map((h) => h.header); // three consecutive, parent-linked blocks
const TESTNET_GENESIS = PROFILES.testnet.expectedGenesis;
const SUBSCRIBE = [
	"chain_subscribeNewHeads",
	"chain_subscribeFinalizedHeads",
	"state_subscribeRuntimeVersion",
];

/** A fake RPC node: answers the watcher's reads and pushes notifications on demand. */
async function startFakeNode(options: { genesis?: string; refuse?: string[] } = {}) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const state = { methods: [] as string[], connections: 0, userAgents: [] as string[] };
	const results: Record<string, unknown> = {
		chain_getBlockHash: options.genesis ?? TESTNET_GENESIS,
		system_chain: "FLOP Testnet",
		state_getRuntimeVersion: { specName: "flop-testnet", specVersion: 1014035 },
		state_call: testnet?.babeConfiguration,
		system_health: { peers: 17, isSyncing: false, shouldHavePeers: true },
		chain_subscribeNewHeads: "sub-new",
		chain_subscribeFinalizedHeads: "sub-fin",
		state_subscribeRuntimeVersion: "sub-rv",
	};
	server.on("connection", (socket, req) => {
		state.connections++;
		state.userAgents.push(req.headers["user-agent"] ?? "");
		socket.on("message", (data) => {
			const { id, method } = JSON.parse(String(data));
			state.methods.push(method);
			const reply = options.refuse?.includes(method)
				? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }
				: { jsonrpc: "2.0", id, result: results[method] };
			socket.send(JSON.stringify(reply));
		});
	});
	return {
		url: `ws://127.0.0.1:${address.port}`,
		state,
		push(method: string, result: unknown) {
			const frame = JSON.stringify({
				jsonrpc: "2.0",
				method,
				params: { subscription: "x", result },
			});
			for (const client of server.clients) client.send(frame);
		},
		dropConnections() {
			for (const client of server.clients) client.terminate();
		},
		close() {
			for (const client of server.clients) client.terminate();
			server.close();
		},
	};
}

/** A manual clock for the watcher's timers: nothing fires until the test advances it. */
function manualClock() {
	let now = 0;
	let nextId = 0;
	const tasks = new Map<number, { at: number; fn: () => void }>();
	return {
		schedule: (ms: number, fn: () => void) => {
			const id = ++nextId;
			tasks.set(id, { at: now + ms, fn });
			return () => tasks.delete(id);
		},
		advance(ms: number) {
			const until = now + ms;
			for (;;) {
				const due = [...tasks]
					.filter(([, t]) => t.at <= until)
					.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!due) break;
				tasks.delete(due[0]);
				now = due[1].at;
				due[1].fn();
			}
			now = until;
		},
	};
}

/** Lets socket I/O run until `check` passes; never waits on a clock. */
async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
	for (let i = 0; i < 20_000; i++) {
		if (await check()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(`never happened: ${what}`);
}

interface Sample {
	value: number;
	labels: Record<string, string | number>;
	metricName?: string;
}
async function sample(
	metric: { get(): Promise<{ values: Sample[] }> },
	labels: Record<string, string> = {},
	metricName?: string,
): Promise<number | undefined> {
	const { values } = await metric.get();
	return values.find(
		(v) =>
			(metricName === undefined || v.metricName === metricName) &&
			Object.entries(labels).every(([k, value]) => v.labels[k] === value),
	)?.value;
}

const net = { network: "testnet" };
const blockNumber = (n: number) => `0x${n.toString(16)}`;

describe("chain watcher", () => {
	let metrics: Metrics;
	let clock: ReturnType<typeof manualClock>;
	let watcher: ChainWatcher | undefined;
	let node: Awaited<ReturnType<typeof startFakeNode>> | undefined;

	const start = async (nodeOptions: Parameters<typeof startFakeNode>[0] = {}, rpcWs?: string) => {
		node = await startFakeNode(nodeOptions);
		watcher = startChainWatcher({
			network: { ...PROFILES.testnet, rpcWs: rpcWs ?? node.url },
			metrics,
			log: createLogger("error", () => {}),
			random: () => 0.5,
			schedule: clock.schedule,
		});
		return node;
	};
	const subscribed = (fake: { state: { methods: string[] } }) =>
		eventually(
			async () =>
				SUBSCRIBE.every((m) => fake.state.methods.includes(m)) &&
				(await sample(metrics.wsConnected, net)) === 1,
			"subscribed",
		);

	beforeEach(() => {
		clock = manualClock();
		metrics = createMetrics({ defaultMetrics: false });
	});
	afterEach(async () => {
		await watcher?.stop();
		node?.close();
		watcher = undefined;
		node = undefined;
	});

	it("checks identity, subscribes and probes over one connection", async () => {
		const fake = await start();
		await subscribed(fake);
		await eventually(
			async () => (await sample(metrics.probeSuccess, { target: "rpc_ws" })) === 1,
			"ping",
		);

		assert.deepEqual(fake.state.methods.toSorted(), [
			"chain_getBlockHash",
			"chain_subscribeFinalizedHeads",
			"chain_subscribeNewHeads",
			"state_call",
			"state_getRuntimeVersion",
			"state_subscribeRuntimeVersion",
			"system_chain",
			"system_health",
		]);
		assert.match(fake.state.userAgents[0] ?? "", /^flop-watch\//);
		assert.equal(await sample(metrics.genesisMatch, { source: "rpc_ws" }), 1);
		assert.equal(
			await sample(metrics.chainInfo, {
				chain: "FLOP Testnet",
				spec_name: "flop-testnet",
				genesis_hash: TESTNET_GENESIS,
			}),
			1,
		);
		assert.equal(await sample(metrics.specVersion, net), 1014035);
		assert.equal(await sample(metrics.slotDuration, net), 1);
		assert.equal(await sample(metrics.wsConnects, net), 1);
		assert.equal(await sample(metrics.nodePeers, { transport: "ws" }), 17);
		assert.equal(await sample(metrics.nodeIsSyncing, { transport: "ws" }), 0);
	});

	it("tracks heads, skips, rewinds and parent-linked block intervals", async () => {
		const fake = await start();
		await subscribed(fake);
		const [first, second, third] = HEADERS;
		assert.ok(first && second && third);

		for (const header of HEADERS) fake.push("chain_newHead", header);
		await eventually(async () => (await sample(metrics.bestBlock, net)) === 109787, "best head");
		const intervals = () =>
			sample(metrics.blockInterval, net, "flopwatch_chain_block_interval_seconds_count");
		assert.equal(await intervals(), 2);
		assert.equal(
			await sample(metrics.blockInterval, net, "flopwatch_chain_block_interval_seconds_sum"),
			2,
		);

		fake.push("chain_newHead", { ...third, number: blockNumber(109790) });
		fake.push("chain_newHead", second);
		fake.push("chain_newHead", { ...third, parentHash: first.parentHash });
		fake.push("chain_finalizedHead", first);
		fake.push("state_runtimeVersion", { specName: "flop-testnet", specVersion: 1014036 });
		fake.push("chain_newHead", { number: 5 });
		await eventually(
			async () => (await sample(metrics.schemaMismatch, { field: "header" })) === 1,
			"mismatch",
		);

		assert.equal(await sample(metrics.headSkippedBlocks, net), 2);
		assert.equal(await sample(metrics.headRewinds, net), 1);
		assert.equal(await intervals(), 2, "no interval without a verified parent link");
		assert.equal(await sample(metrics.finalizedBlock, net), 109785);
		assert.ok(((await sample(metrics.finalizedHeadReceived, net)) ?? 0) > 0);
		assert.equal(await sample(metrics.specVersion, net), 1014036);
	});

	it("keeps collecting but reports a genesis mismatch", async () => {
		const fake = await start({ genesis: PROFILES.devnet.expectedGenesis });
		await subscribed(fake);
		assert.equal(await sample(metrics.genesisMatch, { source: "rpc_ws" }), 0);
	});

	it("drops stale values and reconnects with backoff when the node drops the connection", async () => {
		const fake = await start();
		await subscribed(fake);
		fake.push("chain_newHead", HEADERS[0]);
		await eventually(async () => (await sample(metrics.bestBlock, net)) !== undefined, "best head");

		fake.dropConnections();
		await eventually(async () => (await sample(metrics.wsConnected, net)) === 0, "disconnect");
		const { values } = await metrics.wsDisconnects.get();
		assert.equal(
			values.reduce((sum, v) => sum + v.value, 0),
			1,
		);
		assert.equal(await sample(metrics.bestBlock, net), undefined, "best block removed");
		assert.ok(((await sample(metrics.bestHeadReceived, net)) ?? 0) > 0, "receive time kept");
		assert.equal(await sample(metrics.probeSuccess, { target: "rpc_ws" }), 0);

		clock.advance(BACKOFF_BASE_MS); // full jitter with random 0.5 waits 500 ms
		await subscribed(fake);
		assert.equal(fake.state.connections, 2);
		assert.equal(await sample(metrics.wsConnects, net), 2);
	});

	it("reconnects with reason stall_timeout when no head arrives for 30 s", async () => {
		const fake = await start();
		await subscribed(fake);
		clock.advance(WATCHDOG_MS);
		await eventually(
			async () => (await sample(metrics.wsDisconnects, { reason: "stall_timeout" })) === 1,
			"stall timeout",
		);
	});

	it("closes and retries when a subscription is refused", async () => {
		await start({ refuse: ["chain_subscribeNewHeads"] });
		await eventually(
			async () => (await sample(metrics.wsDisconnects, { reason: "error" })) === 1,
			"refused subscription",
		);
		assert.equal(await sample(metrics.probeTotal, { target: "rpc_ws", result: "rpc_error" }), 1);
		assert.equal(await sample(metrics.wsConnected, net), 0);
	});

	it("records an unreachable node as an rpc_ws probe failure, and stops for good", async () => {
		const closed = createServer().listen(0, "127.0.0.1");
		await once(closed, "listening");
		const address = closed.address();
		assert.ok(address && typeof address === "object");
		closed.close();
		await once(closed, "close");

		const fake = await start({}, `ws://127.0.0.1:${address.port}`);
		await eventually(
			async () =>
				(await sample(metrics.probeTotal, { target: "rpc_ws", result: "network_error" })) === 1,
			"connect failure",
		);
		assert.equal(await sample(metrics.probeSuccess, { target: "rpc_ws" }), 0);
		assert.equal(await sample(metrics.wsConnects, net), undefined);

		await watcher?.stop();
		clock.advance(60_000);
		assert.equal(fake.state.connections, 0);
		assert.equal(
			await sample(metrics.probeTotal, { target: "rpc_ws", result: "network_error" }),
			1,
		);
	});
});
