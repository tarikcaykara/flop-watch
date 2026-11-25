// Scheduled HTTP probes (architecture §4, §5): a loop per probe with first-run jitter, no
// overlapping runs and Retry-After back-off, and the HTTP JSON-RPC probes of one network.

import { isRpcHeader, parseBlockNumber } from "./babe.ts";
import { realSchedule, type Schedule } from "./clock.ts";
import type { NetworkConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Metrics, ProbeResult } from "./metrics.ts";
import { type RpcOutcome, rpcCall } from "./rpc-http.ts";

export const FIRST_RUN_JITTER_MS = 5_000;
export const RETRY_AFTER_CAP_MS = 10 * 60_000;
export const RPC_HTTP_INTERVAL_MS = 30_000;
export const GENESIS_INTERVAL_MS = 10 * 60_000;
const GENESIS_RE = /^0x[0-9a-f]{64}$/;

export interface ProbeLoop {
	/** Stops scheduling. A run in flight finishes on its own; it is not awaited. */
	readonly stop: () => Promise<void>;
}

export interface LoopOptions {
	readonly log: Logger;
	/** Timer source; tests inject a manual clock. */
	readonly schedule?: Schedule;
	/** Monotonic milliseconds; tests inject the manual clock's time. */
	readonly now?: () => number;
	/** Source of the first-run jitter fraction in [0, 1). */
	readonly random?: () => number;
}

/**
 * Runs `run` every `intervalMs`: first after a random 0–5 s jitter; never overlapping, because the
 * next run is scheduled only when the current one ends, and a run that outlasts the interval skips
 * the missed slots; never sooner than the Retry-After it returns (ms, capped at 10 min). A run
 * that throws is logged and the loop goes on.
 */
export function startLoop(
	name: string,
	intervalMs: number,
	run: () => Promise<number | null>,
	options: LoopOptions,
): ProbeLoop {
	const schedule = options.schedule ?? realSchedule;
	const now = options.now ?? (() => performance.now());
	const random = options.random ?? Math.random;
	let stopped = false;

	const tick = async () => {
		if (stopped) return;
		const started = now();
		let retryAfterMs: number | null = null;
		try {
			retryAfterMs = await run();
		} catch (err) {
			options.log.error("probe run failed", { probe: name, err });
		}
		if (stopped) return;
		const elapsed = now() - started;
		let delay = intervalMs - (elapsed % intervalMs);
		if (retryAfterMs !== null) delay = Math.max(delay, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
		cancel = schedule(delay, () => void tick());
	};
	let cancel = schedule(Math.floor(random() * FIRST_RUN_JITTER_MS), () => void tick());

	return {
		stop: async () => {
			stopped = true;
			cancel();
		},
	};
}

/**
 * The HTTP JSON-RPC probes of one network: `chain_getHeader` + `system_health` every 30 s
 * (the rpc_http probe), and `chain_getBlockHash [0]` every 10 min for the genesis check.
 */
export function startHttpRpcProbes(
	options: { network: NetworkConfig; metrics: Metrics } & LoopOptions,
): ProbeLoop {
	const { network, metrics, log } = options;
	const byNetwork = { network: network.name };
	const target = { network: network.name, target: "rpc_http" } as const;
	const httpTransport = { network: network.name, transport: "http" } as const;

	/** Records one request; `valid` is false when an ok answer had the wrong shape. */
	const record = (
		method: string,
		outcome: RpcOutcome,
		valid: boolean,
		field: string,
	): ProbeResult => {
		const result: ProbeResult =
			outcome.result === "ok" && !valid ? "invalid_response" : outcome.result;
		metrics.probeTotal.inc({ ...target, result });
		metrics.probeDuration.observe(target, outcome.ms / 1000);
		if (outcome.result === "ok" && !valid) {
			metrics.schemaMismatch.inc({ network: network.name, target: "rpc_http", field });
		}
		if (outcome.result !== "ok") {
			log.warn("rpc http request failed", {
				network: network.name,
				method,
				result,
				error: outcome.error,
			});
		}
		return result;
	};
	const retryAfter = (outcome: RpcOutcome) =>
		outcome.result === "ok" ? null : outcome.retryAfterMs;

	const headAndHealth = async (): Promise<number | null> => {
		const header = await rpcCall(network.rpcHttp, "chain_getHeader");
		let best: number | null = null;
		if (header.result === "ok" && isRpcHeader(header.value)) {
			try {
				best = parseBlockNumber(header.value.number);
			} catch {
				best = null;
			}
		}
		const headerResult = record("chain_getHeader", header, best !== null, "header");
		if (best === null) metrics.httpBestBlock.remove(byNetwork);
		else metrics.httpBestBlock.set(byNetwork, best);

		// A rate-limited endpoint gets no second request in the same cycle.
		if (headerResult === "rate_limited") {
			metrics.probeSuccess.set(target, 0);
			metrics.nodePeers.remove(httpTransport);
			metrics.nodeIsSyncing.remove(httpTransport);
			return retryAfter(header);
		}

		const health = await rpcCall(network.rpcHttp, "system_health");
		const value = health.result === "ok" ? health.value : undefined;
		const peers =
			typeof value === "object" &&
			value !== null &&
			"peers" in value &&
			typeof value.peers === "number"
				? value.peers
				: null;
		const isSyncing =
			typeof value === "object" &&
			value !== null &&
			"isSyncing" in value &&
			typeof value.isSyncing === "boolean"
				? value.isSyncing
				: null;
		const healthResult = record(
			"system_health",
			health,
			peers !== null && isSyncing !== null,
			"health",
		);
		if (peers === null) metrics.nodePeers.remove(httpTransport);
		else metrics.nodePeers.set(httpTransport, peers);
		if (isSyncing === null) metrics.nodeIsSyncing.remove(httpTransport);
		else metrics.nodeIsSyncing.set(httpTransport, isSyncing ? 1 : 0);

		const ok = headerResult === "ok" && healthResult === "ok";
		metrics.probeSuccess.set(target, ok ? 1 : 0);
		if (ok) metrics.probeLastSuccess.set(target, Date.now() / 1000);
		const waits = [retryAfter(header), retryAfter(health)].filter((ms) => ms !== null);
		return waits.length > 0 ? Math.max(...waits) : null;
	};

	const genesis = async (): Promise<number | null> => {
		const outcome = await rpcCall(network.rpcHttp, "chain_getBlockHash", [0]);
		const hash =
			outcome.result === "ok" && typeof outcome.value === "string" && GENESIS_RE.test(outcome.value)
				? outcome.value
				: null;
		record("chain_getBlockHash", outcome, hash !== null, "genesis");
		const labels = { ...byNetwork, source: "rpc_http" } as const;
		if (hash === null) metrics.genesisMatch.remove(labels);
		else metrics.genesisMatch.set(labels, hash === network.expectedGenesis ? 1 : 0);
		return retryAfter(outcome);
	};

	const loops = [
		startLoop(`${network.name} rpc_http`, RPC_HTTP_INTERVAL_MS, headAndHealth, options),
		startLoop(`${network.name} genesis`, GENESIS_INTERVAL_MS, genesis, options),
	];
	return {
		stop: async () => {
			await Promise.all(loops.map((loop) => loop.stop()));
		},
	};
}
