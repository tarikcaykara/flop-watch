// The fake FLOP service of the stack e2e (architecture §10): the RPC, faucet and explorer of Devnet
// and Testnet on one port, from the recorded fixtures (test/fixtures/). Offline and deterministic:
// each chain continues from its three recorded headers, one parent-linked block per second, with
// finality two blocks behind.
//
// Routes, for <net> = devnet or testnet:
// - WebSocket and POST /<net>: JSON-RPC, the read methods the collector calls;
// - GET /<net>/faucet/limits, /<net>/faucet/health, /<net>/faucet/chain and /<net>/api/stats;
// - GET /healthz, for the Compose health check.
//
// Where it departs from the recordings, on purpose:
// - Testnet /limits says faucet.status "unknown", with both sponsor lanes "unknown": the shape seen
//   on 2026-11-25 (research.md §6), for mvp §6 criterion 4. Devnet stays "open".
// - No Testnet /api/stats 200 was recorded (the explorer answered 503), so the Devnet body serves
//   both networks.
// - /limits asOf follows the clock, and the explorer's latestBlockNumber follows the fake chain.

import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { decodeCompact, hexToBytes, parseBlockNumber, type RpcHeader } from "../../src/babe.ts";
import { headerHash } from "../../src/blake2b.ts";
import { serviceBody, withField } from "../helpers.ts";

const PORT = 8080;
const BLOCK_MS = 1_000;

type Net = "devnet" | "testnet";
const NETS: readonly Net[] = ["devnet", "testnet"];
const isNet = (value: unknown): value is Net => value === "devnet" || value === "testnet";

interface HeaderFixtures {
	networks: Record<Net, { babeConfiguration: string; headers: Array<{ header: RpcHeader }> }>;
}
const recorded: HeaderFixtures = JSON.parse(
	readFileSync(new URL("../fixtures/headers.json", import.meta.url), "utf8"),
);

/** Recorded on 2026-11-25 (research.md §2; poc/results/2026-11-25/rpc-http.json). */
const NODE: Record<Net, { runtime: { specName: string; specVersion: number }; peers: number }> = {
	devnet: { runtime: { specName: "tzkv-runtime", specVersion: 1014034 }, peers: 26 },
	testnet: { runtime: { specName: "flop-testnet", specVersion: 1014035 }, peers: 17 },
};

/** The genesis hash and chain name, from the recorded faucet /chain body. */
const IDENTITY = {
	devnet: serviceBody("devnet", "faucet_chain", 200),
	testnet: serviceBody("testnet", "faucet_chain", 200),
} as Record<Net, { genesisHash: string; chain: string }>;

let unknownLimits = withField(
	serviceBody("testnet", "faucet_limits", 200),
	"faucet.status",
	"unknown",
);
for (const lane of ["miner", "validator"]) {
	unknownLimits = withField(unknownLimits, `sponsor.${lane}`, {
		status: "unknown",
		reason: "sponsor_unavailable",
	});
}
const LIMITS: Record<Net, unknown> = {
	devnet: serviceBody("devnet", "faucet_limits", 200),
	testnet: unknownLimits,
};

interface Route {
	readonly status: number;
	readonly body: unknown;
	readonly headers?: Record<string, string>;
}
/** As recorded: Testnet /health answered 503 "degraded", with Retry-After: 60. */
const HEALTH: Record<Net, Route> = {
	devnet: { status: 200, body: serviceBody("devnet", "faucet_health", 200) },
	testnet: {
		status: 503,
		body: serviceBody("testnet", "faucet_health", 503),
		headers: { "retry-after": "60" },
	},
};

/**
 * The last three headers of each chain, at first the recorded ones: finalized first, best last, so
 * finality is two blocks behind. Each block appends one header and drops the oldest.
 */
const chains: Record<Net, RpcHeader[]> = {
	devnet: recorded.networks.devnet.headers.map((h) => h.header),
	testnet: recorded.networks.testnet.headers.map((h) => h.header),
};

function head(net: Net, kind: "best" | "finalized"): RpcHeader {
	const header = kind === "best" ? chains[net].at(-1) : chains[net][0];
	if (!header) throw new Error(`no ${kind} header for ${net}`);
	return header;
}

/** The block after `prev`: the next number, `prev`'s hash as its parent, and the next BABE slot. */
function nextHeader(prev: RpcHeader): RpcHeader {
	return {
		...prev,
		parentHash: headerHash(prev),
		number: `0x${(parseBlockNumber(prev.number) + 1).toString(16)}`,
		digest: { logs: prev.digest.logs.map(nextSlot) },
	};
}

/**
 * A BABE pre-runtime log, `0x06 | "BABE" | compact(length) | variant u8 | authorityIndex u32 LE |
 * slot u64 LE | …`, with its slot advanced by one; any other log unchanged.
 */
function nextSlot(log: string): string {
	if (!log.startsWith("0x0642414245")) return log;
	const bytes = hexToBytes(log);
	const slotAt = 5 + decodeCompact(bytes, 5).length + 5;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setBigUint64(slotAt, view.getBigUint64(slotAt, true) + 1n, true);
	return `0x${Buffer.from(bytes).toString("hex")}`;
}

interface Call {
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
}

/** The JSON-RPC reply to the read methods the collector calls; anything else is "Method not found". */
function reply(net: Net, call: Call) {
	const args = Array.isArray(call.params) ? call.params : [];
	const result = (value: unknown) => ({ jsonrpc: "2.0", id: call.id ?? null, result: value });
	switch (call.method) {
		case "chain_getBlockHash":
			if (args[0] === 0) return result(IDENTITY[net].genesisHash);
			break;
		case "system_chain":
			return result(IDENTITY[net].chain);
		case "state_getRuntimeVersion":
			return result(NODE[net].runtime);
		case "state_call":
			if (args[0] === "BabeApi_configuration")
				return result(recorded.networks[net].babeConfiguration);
			break;
		case "system_health":
			return result({ peers: NODE[net].peers, isSyncing: false, shouldHavePeers: true });
		case "chain_getHeader":
			return result(head(net, "best"));
	}
	return {
		jsonrpc: "2.0",
		id: call.id ?? null,
		error: { code: -32601, message: "Method not found" },
	};
}

/** The notification each subscription method starts, and what it carries now. */
const SUBSCRIPTIONS: Record<string, { notification: string; current: (net: Net) => unknown }> = {
	chain_subscribeNewHeads: { notification: "chain_newHead", current: (net) => head(net, "best") },
	chain_subscribeFinalizedHeads: {
		notification: "chain_finalizedHead",
		current: (net) => head(net, "finalized"),
	},
	state_subscribeRuntimeVersion: {
		notification: "state_runtimeVersion",
		current: (net) => NODE[net].runtime,
	},
};

interface Subscriber {
	readonly socket: WebSocket;
	/** Subscription id by notification method. */
	readonly ids: Map<string, string>;
}
const subscribers: Record<Net, Set<Subscriber>> = { devnet: new Set(), testnet: new Set() };
let nextSubscription = 0;

function notify(subscriber: Subscriber, notification: string, result: unknown): void {
	const subscription = subscriber.ids.get(notification);
	if (subscription === undefined) return;
	const params = { subscription, result };
	subscriber.socket.send(JSON.stringify({ jsonrpc: "2.0", method: notification, params }));
}

function onWsMessage(net: Net, subscriber: Subscriber, data: string): void {
	let call: Call;
	try {
		call = JSON.parse(data);
	} catch {
		return;
	}
	const subscription = typeof call.method === "string" ? SUBSCRIPTIONS[call.method] : undefined;
	if (!subscription) {
		subscriber.socket.send(JSON.stringify(reply(net, call)));
		return;
	}
	// As a node does: the subscription id first, then the current value at once.
	const id = `sub-${++nextSubscription}`;
	subscriber.ids.set(subscription.notification, id);
	subscriber.socket.send(JSON.stringify({ jsonrpc: "2.0", id: call.id ?? null, result: id }));
	notify(subscriber, subscription.notification, subscription.current(net));
}

/** The GET routes of one network, by path below /<net>. */
function getRoute(net: Net, path: string): Route | null {
	switch (path) {
		case "/faucet/limits":
			return { status: 200, body: withField(LIMITS[net], "asOf", new Date().toISOString()) };
		case "/faucet/health":
			return HEALTH[net];
		case "/faucet/chain":
			return { status: 200, body: IDENTITY[net] };
		case "/api/stats": {
			const latest = parseBlockNumber(head(net, "best").number);
			const stats = serviceBody("devnet", "explorer_stats", 200);
			return { status: 200, body: withField(stats, "latestBlockNumber", latest) };
		}
	}
	return null;
}

function send(response: ServerResponse, { status, body, headers }: Route): void {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

const NOT_FOUND: Route = { status: 404, body: { error: "not found" } };

const server = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/healthz") {
		return send(response, { status: 200, body: {} });
	}
	const [, net, ...rest] = (request.url ?? "").split("/");
	const path = `/${rest.join("/")}`;
	if (!isNet(net)) return send(response, NOT_FOUND);

	if (request.method === "POST" && path === "/") {
		let text = "";
		for await (const chunk of request) text += String(chunk);
		let call: Call;
		try {
			call = JSON.parse(text);
		} catch {
			return send(response, { status: 400, body: { error: "not JSON" } });
		}
		return send(response, { status: 200, body: reply(net, call) });
	}
	const route = request.method === "GET" ? getRoute(net, path) : null;
	send(response, route ?? NOT_FOUND);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, upgradeHead) => {
	const net = request.url?.slice(1);
	if (!isNet(net)) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(request, socket, upgradeHead, (ws) => {
		const subscriber: Subscriber = { socket: ws, ids: new Map() };
		subscribers[net].add(subscriber);
		ws.on("close", () => subscribers[net].delete(subscriber));
		ws.on("message", (data) => onWsMessage(net, subscriber, String(data)));
	});
});

setInterval(() => {
	for (const net of NETS) {
		chains[net].push(nextHeader(head(net, "best")));
		chains[net].shift();
		for (const subscriber of subscribers[net]) {
			notify(subscriber, "chain_newHead", head(net, "best"));
			notify(subscriber, "chain_finalizedHead", head(net, "finalized"));
		}
	}
}, BLOCK_MS);

server.listen(PORT, () => {
	console.log(JSON.stringify({ msg: "fake FLOP service listening", port: PORT }));
});

// PID 1 in its container: without a handler, SIGTERM would wait for Docker's SIGKILL.
process.once("SIGTERM", () => process.exit(0));
