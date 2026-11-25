import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import type { RpcHeader } from "../src/babe.ts";
import {
	BACKOFF_BASE_MS,
	type ChainWatcher,
	CLOSE_DEADLINE_MS,
	HEALTH_INTERVAL_MS,
	STABLE_RESET_MS,
	startChainWatcher,
	WATCHDOG_MS,
} from "../src/chain-watcher.ts";
import { PROFILES } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { createMetrics, type Metrics } from "../src/metrics.ts";
import { REQUEST_TIMEOUT_MS } from "../src/rpc-http.ts";
import { eventually, type ManualClock, manualClock, sample } from "./helpers.ts";

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
const SUBSCRIPTION_IDS: Record<string, string> = {
	chain_subscribeNewHeads: "sub-new",
	chain_subscribeFinalizedHeads: "sub-fin",
	state_subscribeRuntimeVersion: "sub-rv",
};
const NOTIFICATION_IDS: Record<string, string> = {
	chain_newHead: "sub-new",
	chain_finalizedHead: "sub-fin",
	state_runtimeVersion: "sub-rv",
};

interface NodeOptions {
	genesis?: string;
	/** Methods answered with a JSON-RPC error. */
	refuse?: string[];
	/** Methods never answered. */
	silent?: string[];
}

/** A fake RPC node: answers the watcher's reads and pushes notifications on demand. */
async function startFakeNode(options: NodeOptions = {}) {
	const http = createHttpServer();
	const wss = new WebSocketServer({ noServer: true });
	const rawSockets = new Set<Duplex>();
	const state = { methods: [] as string[], connections: 0, userAgents: [] as string[] };
	const results: Record<string, unknown> = {
		chain_getBlockHash: options.genesis ?? TESTNET_GENESIS,
		system_chain: "FLOP Testnet",
		state_getRuntimeVersion: { specName: "flop-testnet", specVersion: 1014035 },
		state_call: testnet?.babeConfiguration,
		system_health: { peers: 17, isSyncing: false, shouldHavePeers: true },
		...SUBSCRIPTION_IDS,
	};
	http.on("upgrade", (req, socket, head) => {
		rawSockets.add(socket);
		wss.handleUpgrade(req, socket, head, (client) => {
			state.connections++;
			state.userAgents.push(req.headers["user-agent"] ?? "");
			client.on("message", (data) => {
				const { id, method } = JSON.parse(String(data));
				state.methods.push(method);
				if (options.silent?.includes(method)) return;
				const reply = options.refuse?.includes(method)
					? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }
					: { jsonrpc: "2.0", id, result: results[method] };
				client.send(JSON.stringify(reply));
			});
		});
	});
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	const address = http.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `ws://127.0.0.1:${address.port}`,
		state,
		results,
		push(method: string, result: unknown, subscription = NOTIFICATION_IDS[method]) {
			const frame = JSON.stringify({ jsonrpc: "2.0", method, params: { subscription, result } });
			for (const client of wss.clients) client.send(frame);
		},
		dropConnections() {
			for (const client of wss.clients) client.terminate();
		},
		/** Stops reading every open connection: a half-open peer that answers nothing, not even a close. */
		freeze() {
			for (const socket of rawSockets) socket.pause();
		},
		close() {
			for (const socket of rawSockets) socket.destroy();
			wss.close();
			http.close();
		},
	};
}
type FakeNode = Awaited<ReturnType<typeof startFakeNode>>;

/** A port that refuses connections. */
async function closedPort(): Promise<number> {
	const server = createTcpServer().listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	server.close();
	await once(server, "close");
	return address.port;
}

/** A TCP server that accepts connections but never answers the WebSocket handshake. */
async function silentTcpServer() {
	const sockets = new Set<Socket>();
	const server = createTcpServer((socket) => sockets.add(socket)).listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `ws://127.0.0.1:${address.port}`,
		close() {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

const net = { network: "testnet" };
const blockNumber = (n: number) => `0x${n.toString(16)}`;

describe("chain watcher", () => {
	let metrics: Metrics;
	let clock: ManualClock;
	let logs: Array<Record<string, unknown>>;
	let watcher: ChainWatcher | undefined;
	const cleanups: Array<() => void> = [];

	const watch = (rpcWs: string) => {
		watcher = startChainWatcher({
			network: { ...PROFILES.testnet, rpcWs },
			metrics,
			log: createLogger("debug", (line) => logs.push(JSON.parse(line))),
			random: () => 0.5,
			schedule: clock.schedule,
		});
		return watcher;
	};
	const start = async (options: NodeOptions = {}) => {
		const node = await startFakeNode(options);
		cleanups.push(() => node.close());
		watch(node.url);
		return node;
	};
	const subscribedOn = (node: FakeNode, connections: number) =>
		eventually(
			async () =>
				node.state.connections === connections && (await sample(metrics.wsConnected, net)) === 1,
			`subscribed on connection ${connections}`,
		);
	const reconnectDelays = () =>
		logs.filter((l) => l["msg"] === "ws reconnect scheduled").map((l) => l["delayMs"]);
	const connectAttempts = () => logs.filter((l) => l["msg"] === "ws connecting").length;

	beforeEach(() => {
		clock = manualClock();
		metrics = createMetrics({ defaultMetrics: false });
		logs = [];
	});
	afterEach(async () => {
		const stopping = watcher?.stop();
		clock.advance(CLOSE_DEADLINE_MS); // a frozen peer never acknowledges the close
		await stopping;
		for (const cleanup of cleanups.splice(0)) cleanup();
		watcher = undefined;
	});

	it("checks identity, subscribes, and pings every 30 s as the rpc_ws probe", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		await eventually(
			async () => (await sample(metrics.nodePeers, { transport: "ws" })) === 17,
			"ping",
		);

		assert.deepEqual(node.state.methods.toSorted(), [
			"chain_getBlockHash",
			"chain_subscribeFinalizedHeads",
			"chain_subscribeNewHeads",
			"state_call",
			"state_getRuntimeVersion",
			"state_subscribeRuntimeVersion",
			"system_chain",
			"system_health",
		]);
		assert.match(node.state.userAgents[0] ?? "", /^flop-watch\//);
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
		assert.equal(await sample(metrics.nodeIsSyncing, { transport: "ws" }), 0);
		assert.equal(await sample(metrics.probeSuccess, { target: "rpc_ws" }), 1);

		// A head at 20 s moves the watchdog past the second ping at 30 s.
		clock.advance(20_000);
		node.push("chain_newHead", HEADERS[0]);
		await eventually(async () => (await sample(metrics.bestBlock, net)) !== undefined, "head");
		clock.advance(HEALTH_INTERVAL_MS - 20_000);
		await eventually(
			async () => (await sample(metrics.probeTotal, { target: "rpc_ws", result: "ok" })) === 2,
			"second ping",
		);
		assert.equal(node.state.methods.filter((m) => m === "system_health").length, 2);
	});

	it("tracks heads, skips, rewinds and parent-linked block intervals", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		const [first, second, third] = HEADERS;
		assert.ok(first && second && third);

		for (const header of HEADERS) node.push("chain_newHead", header);
		await eventually(async () => (await sample(metrics.bestBlock, net)) === 109787, "best head");
		const intervals = () =>
			sample(metrics.blockInterval, net, "flopwatch_chain_block_interval_seconds_count");
		assert.equal(await intervals(), 2);
		assert.equal(
			await sample(metrics.blockInterval, net, "flopwatch_chain_block_interval_seconds_sum"),
			2,
		);

		node.push("chain_newHead", { ...third, number: blockNumber(109790) });
		node.push("chain_newHead", second);
		node.push("chain_newHead", { ...third, parentHash: first.parentHash });
		node.push("chain_newHead", { ...third, number: blockNumber(999_999) }, "someone-else");
		node.push("chain_finalizedHead", first);
		node.push("state_runtimeVersion", { specName: "flop-testnet", specVersion: 1014036 });
		node.push("chain_newHead", { number: 5 });
		await eventually(
			async () => (await sample(metrics.schemaMismatch, { field: "header" })) === 1,
			"mismatch",
		);

		assert.equal(await sample(metrics.headSkippedBlocks, net), 2);
		assert.equal(await sample(metrics.headRewinds, net), 1);
		assert.equal(await intervals(), 2, "no interval without a verified parent link");
		assert.equal(await sample(metrics.bestBlock, net), 109787, "unknown subscription ignored");
		assert.equal(await sample(metrics.finalizedBlock, net), 109785);
		assert.ok(((await sample(metrics.finalizedHeadReceived, net)) ?? 0) > 0);
		assert.equal(await sample(metrics.specVersion, net), 1014036);
	});

	it("keeps collecting but reports a genesis mismatch", async () => {
		const node = await start({ genesis: PROFILES.devnet.expectedGenesis });
		await subscribedOn(node, 1);
		assert.equal(await sample(metrics.genesisMatch, { source: "rpc_ws" }), 0);
	});

	it("drops stale values on disconnect, reconnects after the backoff and relabels chain_info", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		node.push("chain_newHead", HEADERS[0]);
		node.push("chain_finalizedHead", HEADERS[0]);
		await eventually(
			async () => (await sample(metrics.finalizedBlock, net)) !== undefined,
			"heads",
		);
		await eventually(
			async () => (await sample(metrics.nodePeers, { transport: "ws" })) === 17,
			"ping",
		);

		node.results["system_chain"] = "FLOP Testnet 2";
		node.dropConnections();
		await eventually(async () => (await sample(metrics.wsConnected, net)) === 0, "disconnect");
		const { values } = await metrics.wsDisconnects.get();
		assert.equal(
			values.reduce((sum, v) => sum + v.value, 0),
			1,
		);
		for (const gauge of [metrics.bestBlock, metrics.finalizedBlock]) {
			assert.equal(await sample(gauge, net), undefined);
		}
		assert.equal(await sample(metrics.nodePeers, { transport: "ws" }), undefined);
		assert.ok(((await sample(metrics.bestHeadReceived, net)) ?? 0) > 0, "receive time kept");
		assert.equal(await sample(metrics.probeSuccess, { target: "rpc_ws" }), 0);
		assert.deepEqual(reconnectDelays(), [500]);

		clock.advance(BACKOFF_BASE_MS);
		await subscribedOn(node, 2);
		assert.equal(await sample(metrics.wsConnects, net), 2);
		assert.equal(await sample(metrics.chainInfo, { chain: "FLOP Testnet" }), undefined);
		assert.equal(await sample(metrics.chainInfo, { chain: "FLOP Testnet 2" }), 1);
	});

	it("doubles the backoff up to the cap while the node is unreachable", async () => {
		watch(`ws://127.0.0.1:${await closedPort()}`);
		for (let attempt = 1; attempt <= 8; attempt++) {
			await eventually(() => reconnectDelays().length === attempt, `failure ${attempt}`);
			const delay = reconnectDelays().at(-1);
			assert.equal(typeof delay, "number");
			clock.advance(Number(delay)); // exactly the backoff: the 10 s connect timeout never fires
		}
		// Full jitter with random 0.5 takes half of min(60 s, 1 s × 2^n).
		assert.deepEqual(reconnectDelays(), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
		assert.equal(
			await sample(metrics.probeTotal, { target: "rpc_ws", result: "network_error" }),
			8,
		);
		assert.equal(await sample(metrics.probeSuccess, { target: "rpc_ws" }), 0);
		assert.equal(await sample(metrics.wsConnects, net), undefined);
	});

	it("resets the backoff after 5 min of a stable connection", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		node.dropConnections();
		await eventually(() => reconnectDelays().length === 1, "first drop");
		clock.advance(BACKOFF_BASE_MS);
		await subscribedOn(node, 2);

		// Keep heads flowing so the watchdog stays quiet while 5 min pass.
		const third = HEADERS[2];
		assert.ok(third);
		for (let t = 0, n = 200_000; t <= STABLE_RESET_MS; t += 20_000, n++) {
			node.push("chain_newHead", { ...third, number: blockNumber(n) });
			await eventually(async () => (await sample(metrics.bestBlock, net)) === n, `head ${n}`);
			clock.advance(20_000);
		}
		node.dropConnections();
		await eventually(() => reconnectDelays().length === 2, "second drop");
		assert.deepEqual(reconnectDelays(), [500, 500]);
	});

	it("reconnects with reason stall_timeout when no head arrives for 30 s", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		clock.advance(WATCHDOG_MS);
		await eventually(
			async () => (await sample(metrics.wsDisconnects, { reason: "stall_timeout" })) === 1,
			"stall timeout",
		);
		clock.advance(BACKOFF_BASE_MS);
		await subscribedOn(node, 2);
	});

	it("abandons a half-open peer that never acknowledges the close, then reconnects", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		node.freeze();
		clock.advance(WATCHDOG_MS);
		assert.equal(await sample(metrics.wsDisconnects, { reason: "stall_timeout" }), undefined);

		clock.advance(CLOSE_DEADLINE_MS);
		assert.equal(await sample(metrics.wsDisconnects, { reason: "stall_timeout" }), 1);
		assert.equal(await sample(metrics.wsConnected, net), 0);
		clock.advance(BACKOFF_BASE_MS);
		await subscribedOn(node, 2);
	});

	it("records a request that is never answered as a timeout", async () => {
		const node = await start({ silent: ["system_health"] });
		await subscribedOn(node, 1);
		clock.advance(REQUEST_TIMEOUT_MS);
		await eventually(
			async () => (await sample(metrics.probeTotal, { target: "rpc_ws", result: "timeout" })) === 1,
			"ping timeout",
		);
		assert.equal(await sample(metrics.probeSuccess, { target: "rpc_ws" }), 0);
		assert.equal(await sample(metrics.nodePeers, { transport: "ws" }), undefined);
	});

	it("records a handshake that never completes as a connect timeout, without the close deadline", async () => {
		const server = await silentTcpServer();
		cleanups.push(() => server.close());
		watch(server.url);
		clock.advance(REQUEST_TIMEOUT_MS);
		await eventually(
			async () => (await sample(metrics.probeTotal, { target: "rpc_ws", result: "timeout" })) === 1,
			"connect timeout",
		);
		assert.equal(await sample(metrics.wsConnects, net), undefined);
		clock.advance(CLOSE_DEADLINE_MS);
		assert.equal(
			logs.some((l) => l["msg"] === "ws close not acknowledged, abandoning the socket"),
			false,
			"the deadline of an already ended session is cancelled",
		);
	});

	it("stop() during the handshake resolves at once, and twice is harmless", async () => {
		const server = await silentTcpServer();
		cleanups.push(() => server.close());
		const current = watch(server.url);
		await Promise.all([current.stop(), current.stop()]);
		clock.advance(60_000);
		assert.equal(connectAttempts(), 1);
		assert.equal(await sample(metrics.wsConnected, net), 0);
	});

	it("counts a connection lost during setup as an rpc_ws probe failure", async () => {
		const node = await start({ silent: ["system_chain"] });
		await eventually(() => node.state.methods.includes("system_chain"), "identity reads sent");
		node.dropConnections();
		await eventually(
			async () =>
				(await sample(metrics.probeTotal, { target: "rpc_ws", result: "network_error" })) === 1,
			"setup failure",
		);
		assert.equal(await sample(metrics.wsConnected, net), 0);
	});

	it("closes and retries when an identity read or a subscription is refused", async () => {
		await start({ refuse: ["state_call"] });
		await eventually(
			async () => (await sample(metrics.wsDisconnects, { reason: "error" })) === 1,
			"refused identity read",
		);
		assert.equal(await sample(metrics.probeTotal, { target: "rpc_ws", result: "rpc_error" }), 1);

		clock.advance(BACKOFF_BASE_MS);
		await eventually(
			async () => (await sample(metrics.wsDisconnects, { reason: "error" })) === 2,
			"second attempt",
		);
		assert.equal(await sample(metrics.wsConnected, net), 0);
	});

	it("closes when a subscription is refused", async () => {
		await start({ refuse: ["chain_subscribeNewHeads"] });
		await eventually(
			async () => (await sample(metrics.wsDisconnects, { reason: "error" })) === 1,
			"refused subscription",
		);
		assert.equal(await sample(metrics.probeTotal, { target: "rpc_ws", result: "rpc_error" }), 1);
	});

	it("stops for good: no reconnect after stop(), even with one pending", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		node.dropConnections();
		await eventually(() => reconnectDelays().length === 1, "drop");

		await watcher?.stop();
		const attempts = connectAttempts();
		clock.advance(60_000);
		assert.equal(connectAttempts(), attempts);
		assert.equal(await sample(metrics.wsConnected, net), 0);
	});

	it("stop() ends a session whose peer never acknowledges the close", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		node.freeze();
		const stopping = watcher?.stop();
		clock.advance(CLOSE_DEADLINE_MS);
		await stopping;
		assert.equal(await sample(metrics.wsConnected, net), 0);
		assert.equal(connectAttempts(), 1);
	});

	it("stop() on an open session resolves through the real close handshake", async () => {
		const node = await start();
		await subscribedOn(node, 1);
		await watcher?.stop(); // no clock advance: the peer acknowledges the close
		assert.equal(await sample(metrics.wsConnected, net), 0);
	});
});
