// WebSocket chain watcher, one per network (architecture §4, §5): identity checks on every connect,
// new-head / finalized-head / runtime-version subscriptions, a system_health ping as the rpc_ws
// probe, a stall watchdog and reconnects with exponential backoff and full jitter.

import {
	type BabePreDigest,
	babeFromHeader,
	decodeBabeConfiguration,
	isRpcHeader,
	parseBlockNumber,
} from "./babe.ts";
import { headerHash } from "./blake2b.ts";
import type { NetworkConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { DisconnectReason, Metrics, ProbeResult } from "./metrics.ts";
import { assertAllowed, REQUEST_TIMEOUT_MS } from "./rpc-http.ts";
import { USER_AGENT } from "./version.ts";

export const WATCHDOG_MS = 30_000;
export const HEALTH_INTERVAL_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** Full jitter can draw 0; this floor keeps a flapping endpoint from a tight reconnect loop. */
export const BACKOFF_MIN_MS = 100;
export const STABLE_RESET_MS = 5 * 60_000;
/** A peer that never answers the closing handshake must not keep a session alive. */
export const CLOSE_DEADLINE_MS = 5_000;
const GENESIS_RE = /^0x[0-9a-f]{64}$/;

const SUBSCRIPTIONS = [
	["chain_subscribeNewHeads", "newHead"],
	["chain_subscribeFinalizedHeads", "finalizedHead"],
	["state_subscribeRuntimeVersion", "runtimeVersion"],
] as const;
type SubscriptionKind = (typeof SUBSCRIPTIONS)[number][1];

/** Remote fields this module can report in flopwatch_schema_mismatch_total. */
type WsField =
	| "message"
	| "header"
	| "genesis"
	| "chain"
	| "runtime_version"
	| "babe_configuration"
	| "subscription"
	| "health";

type Outcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly result: Exclude<ProbeResult, "ok">; readonly error: string };

interface Pending {
	readonly resolve: (outcome: Outcome) => void;
	readonly cancelTimeout: () => void;
}

/** Runs `fn` after `ms` milliseconds and returns a function that cancels it. */
export type Schedule = (ms: number, fn: () => void) => () => void;

const realSchedule: Schedule = (ms, fn) => {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
};
const noop = () => {};

export interface ChainWatcher {
	/**
	 * Stops reconnecting and closes the connection. Resolves once the session has ended: when the
	 * socket closes, or after CLOSE_DEADLINE_MS if the peer never completes the close.
	 */
	readonly stop: () => Promise<void>;
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

export function startChainWatcher(options: {
	network: NetworkConfig;
	metrics: Metrics;
	log: Logger;
	/** Source of the full-jitter fraction in [0, 1); injectable for tests. */
	random?: () => number;
	/** Timer source; tests inject a manual clock instead of mocking global timers. */
	schedule?: Schedule;
}): ChainWatcher {
	const { network, metrics, log } = options;
	const random = options.random ?? Math.random;
	const schedule = options.schedule ?? realSchedule;
	const byNetwork = { network: network.name };
	const probe = { network: network.name, target: "rpc_ws" } as const;
	const wsTransport = { network: network.name, transport: "ws" } as const;

	let stopped = false;
	let attempt = 0;
	let cancelReconnect = noop;
	let session: {
		readonly close: (code: number, text: string) => void;
		readonly ended: Promise<void>;
	} | null = null;
	let chainInfoLabels: Record<"network" | "chain" | "spec_name" | "genesis_hash", string> | null =
		null;

	const mismatch = (field: WsField) =>
		metrics.schemaMismatch.inc({ network: network.name, target: "rpc_ws", field });

	const recordProbe = (result: ProbeResult, seconds: number | null) => {
		metrics.probeTotal.inc({ ...probe, result });
		metrics.probeSuccess.set(probe, result === "ok" ? 1 : 0);
		if (seconds !== null) metrics.probeDuration.observe(probe, seconds);
		if (result === "ok") metrics.probeLastSuccess.set(probe, Date.now() / 1000);
	};

	function scheduleReconnect(): void {
		const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
		attempt++;
		const delay = Math.max(BACKOFF_MIN_MS, Math.floor(random() * ceiling));
		log.info("ws reconnect scheduled", { network: network.name, attempt, delayMs: delay });
		cancelReconnect = schedule(delay, connect);
	}

	function connect(): void {
		if (stopped) return;
		log.debug("ws connecting", { network: network.name, url: network.rpcWs });
		const ws = new WebSocket(network.rpcWs, { headers: { "user-agent": USER_AGENT } });
		let opened = false;
		let subscribed = false;
		let failed = false;
		/** Set once a close is initiated or has happened: from then on nothing may write metrics. */
		let closing = false;
		let ended = false;
		let reason: DisconnectReason = "close";
		let connectTimedOut = false;
		let nextId = 0;
		const pending = new Map<number, Pending>();
		const subscriptions = new Map<string, SubscriptionKind>();
		let prev: { n: number; hash: string; babe: BabePreDigest | null } | null = null;
		let slotDurationMs: number | null = null;
		let cancelWatchdog = noop;
		let cancelHealth = noop;
		let cancelStable = noop;
		let cancelDeadline = noop;
		let pinging = false;
		const { promise: endedPromise, resolve: markEnded } = Promise.withResolvers<void>();

		/** Ends the session exactly once, from the close event or from the close deadline. */
		const onEnded = (code: number) => {
			if (ended) return;
			ended = true;
			closing = true;
			cancelConnect();
			cancelWatchdog();
			cancelStable();
			cancelHealth();
			cancelDeadline();
			for (const entry of pending.values()) {
				entry.cancelTimeout();
				entry.resolve({ ok: false, result: "network_error", error: "connection closed" });
			}
			pending.clear();
			if (session?.ended === endedPromise) session = null;
			markEnded();
			if (stopped) return;

			metrics.wsConnected.set(byNetwork, 0);
			metrics.bestBlock.remove(byNetwork);
			metrics.finalizedBlock.remove(byNetwork);
			metrics.nodePeers.remove(wsTransport);
			metrics.nodeIsSyncing.remove(wsTransport);
			if (!opened) {
				recordProbe(connectTimedOut ? "timeout" : "network_error", null);
				log.warn("ws connect failed", { network: network.name, timedOut: connectTimedOut });
			} else {
				metrics.wsDisconnects.inc({ ...byNetwork, reason });
				if (subscribed) metrics.probeSuccess.set(probe, 0);
				else if (!failed) recordProbe("network_error", null); // closed during setup
				log.warn("ws closed", { network: network.name, reason, code });
			}
			scheduleReconnect();
		};

		/**
		 * Starts the closing handshake; a peer that never finishes it is given up after a deadline.
		 * The global WebSocket has no terminate(), so an abandoned socket lingers until the OS drops
		 * it, but the session (metrics, reconnect, stop()) no longer waits for it.
		 */
		const closeSocket = (code: number, text: string) => {
			if (closing) return;
			closing = true;
			// Scheduled first: closing a CONNECTING socket ends the session synchronously, and
			// onEnded must be able to cancel the deadline.
			cancelDeadline = schedule(CLOSE_DEADLINE_MS, () => {
				log.warn("ws close not acknowledged, abandoning the socket", { network: network.name });
				onEnded(1006);
			});
			ws.close(code, text);
		};
		session = { close: closeSocket, ended: endedPromise };

		const cancelConnect = schedule(REQUEST_TIMEOUT_MS, () => {
			connectTimedOut = true;
			closeSocket(1000, "connect timeout");
		});

		const request = (method: string, params: readonly unknown[] = []): Promise<Outcome> => {
			assertAllowed(method, params);
			const id = ++nextId;
			const { promise, resolve } = Promise.withResolvers<Outcome>();
			const cancelTimeout = schedule(REQUEST_TIMEOUT_MS, () => {
				pending.delete(id);
				resolve({ ok: false, result: "timeout", error: `${method} timed out` });
			});
			pending.set(id, { resolve, cancelTimeout });
			ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			return promise;
		};

		const resetWatchdog = () => {
			cancelWatchdog();
			cancelWatchdog = schedule(WATCHDOG_MS, () => {
				if (closing) return;
				reason = "stall_timeout";
				log.warn("no new head, reconnecting", { network: network.name, afterMs: WATCHDOG_MS });
				closeSocket(4000, "stall_timeout");
			});
		};

		const ping = async () => {
			if (pinging || closing) return;
			pinging = true;
			const started = performance.now();
			const outcome = await request("system_health");
			pinging = false;
			if (closing) return;
			const seconds = (performance.now() - started) / 1000;
			const health = outcome.ok ? outcome.value : undefined;
			if (!outcome.ok || !isObject(health) || !("peers" in health) || !("isSyncing" in health)) {
				metrics.nodePeers.remove(wsTransport);
				metrics.nodeIsSyncing.remove(wsTransport);
				if (outcome.ok) mismatch("health");
				recordProbe(outcome.ok ? "invalid_response" : outcome.result, seconds);
				if (!outcome.ok)
					log.warn("ws health ping failed", { network: network.name, error: outcome.error });
				return;
			}
			recordProbe("ok", seconds);
			if (typeof health.peers === "number") metrics.nodePeers.set(wsTransport, health.peers);
			else {
				mismatch("health");
				metrics.nodePeers.remove(wsTransport);
			}
			if (typeof health.isSyncing === "boolean") {
				metrics.nodeIsSyncing.set(wsTransport, health.isSyncing ? 1 : 0);
			} else {
				mismatch("health");
				metrics.nodeIsSyncing.remove(wsTransport);
			}
		};

		const fail = (result: Exclude<ProbeResult, "ok">, field: WsField | null, error: string) => {
			if (closing) return;
			failed = true;
			if (field) mismatch(field);
			recordProbe(result, null);
			log.warn("ws identity or subscription failed", { network: network.name, result, error });
			reason = "error";
			closeSocket(1000, "setup failed");
		};

		const initialise = async () => {
			const [genesis, chain, runtime, babe] = await Promise.all([
				request("chain_getBlockHash", [0]),
				request("system_chain"),
				request("state_getRuntimeVersion"),
				request("state_call", ["BabeApi_configuration", "0x"]),
			]);
			if (closing) return;
			if (!genesis.ok || !chain.ok || !runtime.ok || !babe.ok) {
				const failure = [genesis, chain, runtime, babe].find((outcome) => !outcome.ok);
				if (failure && !failure.ok) fail(failure.result, null, failure.error);
				return;
			}
			if (typeof genesis.value !== "string" || !GENESIS_RE.test(genesis.value)) {
				return fail("invalid_response", "genesis", "chain_getBlockHash [0] is not a 32-byte hash");
			}
			if (typeof chain.value !== "string") {
				return fail("invalid_response", "chain", "system_chain is not a string");
			}
			const rv = runtime.value;
			if (!isObject(rv) || !("specName" in rv) || !("specVersion" in rv)) {
				return fail("invalid_response", "runtime_version", "state_getRuntimeVersion has no spec");
			}
			const { specName, specVersion } = rv;
			if (typeof specName !== "string" || typeof specVersion !== "number") {
				return fail("invalid_response", "runtime_version", "state_getRuntimeVersion has no spec");
			}
			try {
				if (typeof babe.value !== "string") throw new Error("not a string");
				slotDurationMs = decodeBabeConfiguration(babe.value).slotDurationMs;
			} catch (err) {
				return fail("invalid_response", "babe_configuration", String(err));
			}

			metrics.genesisMatch.set(
				{ ...byNetwork, source: "rpc_ws" },
				genesis.value === network.expectedGenesis ? 1 : 0,
			);
			const info = {
				network: network.name,
				chain: chain.value,
				spec_name: specName,
				genesis_hash: genesis.value,
			};
			if (chainInfoLabels && JSON.stringify(chainInfoLabels) !== JSON.stringify(info)) {
				metrics.chainInfo.remove(chainInfoLabels);
			}
			chainInfoLabels = info;
			metrics.chainInfo.set(info, 1);
			metrics.specVersion.set(byNetwork, specVersion);
			metrics.slotDuration.set(byNetwork, slotDurationMs / 1000);
			if (genesis.value !== network.expectedGenesis) {
				log.warn("genesis mismatch", {
					network: network.name,
					expected: network.expectedGenesis,
					actual: genesis.value,
				});
			}

			for (const [method, kind] of SUBSCRIPTIONS) {
				const outcome = await request(method);
				if (closing) return;
				if (!outcome.ok) return fail(outcome.result, null, `${method}: ${outcome.error}`);
				const id = outcome.value;
				if (!((typeof id === "string" && id !== "") || typeof id === "number")) {
					return fail("invalid_response", "subscription", `${method} returned no subscription id`);
				}
				subscriptions.set(String(id), kind);
			}
			subscribed = true;
			metrics.wsConnected.set(byNetwork, 1);
			log.info("ws subscribed", { network: network.name, chain: chain.value, specVersion });
			resetWatchdog();
			cancelStable = schedule(STABLE_RESET_MS, () => {
				attempt = 0;
			});
			const healthLoop = () => {
				void ping();
				cancelHealth = schedule(HEALTH_INTERVAL_MS, healthLoop);
			};
			healthLoop();
		};

		const onNewHead = (header: unknown) => {
			let n: number;
			let hash: string;
			try {
				if (!isRpcHeader(header)) throw new Error("not a header");
				n = parseBlockNumber(header.number);
				hash = headerHash(header);
			} catch {
				mismatch("header");
				return;
			}
			resetWatchdog();
			metrics.bestHeadReceived.set(byNetwork, Date.now() / 1000);
			metrics.bestBlock.set(byNetwork, n);
			const babe = babeFromHeader(header);
			if (prev) {
				if (n > prev.n + 1) metrics.headSkippedBlocks.inc(byNetwork, n - prev.n - 1);
				if (n <= prev.n) metrics.headRewinds.inc(byNetwork);
				// Only a verified parent link makes the slot delta a block interval (architecture §4).
				if (
					n === prev.n + 1 &&
					header.parentHash === prev.hash &&
					babe &&
					prev.babe &&
					slotDurationMs
				) {
					metrics.blockInterval.observe(
						byNetwork,
						(Number(babe.slot - prev.babe.slot) * slotDurationMs) / 1000,
					);
				}
			}
			prev = { n, hash, babe };
		};

		const onFinalizedHead = (header: unknown) => {
			try {
				if (!isRpcHeader(header)) throw new Error("not a header");
				metrics.finalizedBlock.set(byNetwork, parseBlockNumber(header.number));
				metrics.finalizedHeadReceived.set(byNetwork, Date.now() / 1000);
			} catch {
				mismatch("header");
			}
		};

		const onRuntimeVersion = (version: unknown) => {
			if (
				!isObject(version) ||
				!("specVersion" in version) ||
				typeof version.specVersion !== "number"
			) {
				mismatch("runtime_version");
				return;
			}
			log.info("runtime version", { network: network.name, specVersion: version.specVersion });
			metrics.specVersion.set(byNetwork, version.specVersion);
		};

		ws.addEventListener("open", () => {
			if (closing) return;
			opened = true;
			cancelConnect();
			metrics.wsConnects.inc(byNetwork);
			log.info("ws connected", { network: network.name });
			void initialise();
		});

		ws.addEventListener("message", (event: MessageEvent) => {
			if (closing) return;
			let message: unknown;
			try {
				message = JSON.parse(typeof event.data === "string" ? event.data : "");
			} catch {
				mismatch("message");
				return;
			}
			if (!isObject(message)) return mismatch("message");
			if ("id" in message && typeof message.id === "number") {
				const entry = pending.get(message.id);
				if (!entry) return;
				pending.delete(message.id);
				entry.cancelTimeout();
				if ("error" in message && message.error !== null && message.error !== undefined) {
					const { error } = message;
					const text =
						isObject(error) && "message" in error ? String(error.message) : JSON.stringify(error);
					entry.resolve({ ok: false, result: "rpc_error", error: text });
				} else {
					entry.resolve({ ok: true, value: "result" in message ? message.result : undefined });
				}
				return;
			}
			if (!("params" in message) || !isObject(message.params)) return;
			const { params } = message;
			const id = "subscription" in params ? String(params.subscription) : "";
			const result = "result" in params ? params.result : undefined;
			const kind = subscriptions.get(id);
			if (kind === "newHead") onNewHead(result);
			else if (kind === "finalizedHead") onFinalizedHead(result);
			else if (kind === "runtimeVersion") onRuntimeVersion(result);
		});

		ws.addEventListener("error", () => {
			if (reason === "close") reason = "error";
		});

		ws.addEventListener("close", (event: CloseEvent) => onEnded(event.code));
	}

	connect();
	return {
		stop: async () => {
			stopped = true;
			cancelReconnect();
			const current = session;
			if (current) {
				current.close(1000, "shutdown");
				await current.ended;
			}
			metrics.wsConnected.set(byNetwork, 0);
		},
	};
}
