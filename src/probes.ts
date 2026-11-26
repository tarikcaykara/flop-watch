// Scheduled HTTP probes (architecture §4, §5, §6): a loop per probe with first-run jitter, no
// overlapping runs and Retry-After back-off; the HTTP JSON-RPC probes and the faucet probes of one
// network.

import type { Gauge } from "@prometheus-io/client";
import { isRpcHeader, parseBlockNumber } from "./babe.ts";
import { realSchedule, type Schedule } from "./clock.ts";
import type { NetworkConfig } from "./config.ts";
import { getJson, type HttpOutcome } from "./http.ts";
import type { Logger } from "./log.ts";
import {
	FAUCET_DEPENDENCIES,
	FAUCET_STATUSES,
	type Metrics,
	type ProbeResult,
	SPONSOR_LANES,
	SPONSOR_STATUSES,
	type Target,
} from "./metrics.ts";
import { parseFaucetChain, parseFaucetHealth, parseFaucetLimits } from "./parse.ts";
import { rpcCall } from "./rpc-http.ts";

export const FIRST_RUN_JITTER_MS = 5_000;
export const RETRY_AFTER_CAP_MS = 10 * 60_000;
export const RPC_HTTP_INTERVAL_MS = 30_000;
export const GENESIS_INTERVAL_MS = 10 * 60_000;
export const FAUCET_INTERVAL_MS = 60_000;
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
 * One Retry-After pause for the loops that hit the same host. While it lasts, a wrapped run sends
 * nothing and returns the remaining wait; a run that returns a Retry-After starts it.
 */
function sharedPause(now: () => number) {
	let pausedUntil = 0;
	return (run: () => Promise<number | null>) => async (): Promise<number | null> => {
		const wait = pausedUntil - now();
		if (wait > 0) return wait;
		const retry = await run();
		if (retry !== null) pausedUntil = now() + Math.min(retry, RETRY_AFTER_CAP_MS);
		return retry;
	};
}

/** A failure's Retry-After; a valid answer never pauses anything. */
const retryAfter = (outcome: HttpOutcome) =>
	outcome.result === "ok" ? null : outcome.retryAfterMs;

/** Remote fields the HTTP RPC probes can report in flopwatch_schema_mismatch_total. */
type RpcHttpField = "header" | "health" | "genesis";

/**
 * The HTTP JSON-RPC probes of one network: `chain_getHeader` + `system_health` every 30 s
 * (the rpc_http probe), and `chain_getBlockHash [0]` every 10 min for the genesis check.
 * Both loops share one Retry-After pause, because they hit the same endpoint.
 */
export function startHttpRpcProbes(
	options: { network: NetworkConfig; metrics: Metrics } & LoopOptions,
): ProbeLoop {
	const { network, metrics, log } = options;
	const paced = sharedPause(options.now ?? (() => performance.now()));
	const byNetwork = { network: network.name };
	const target = { network: network.name, target: "rpc_http" } as const;
	const httpTransport = { network: network.name, transport: "http" } as const;
	let stopped = false;

	/** Records one request; `valid` is false when an ok answer had the wrong shape. */
	const record = (
		method: string,
		outcome: HttpOutcome,
		valid: boolean,
		field: RpcHttpField,
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

	const headAndHealth = async (): Promise<number | null> => {
		const header = await rpcCall(network.rpcHttp, "chain_getHeader");
		if (stopped) return null;
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

		// An endpoint that asked us to wait (429, or a Retry-After on any error) gets no second
		// request in the same cycle.
		if (headerResult === "rate_limited" || retryAfter(header) !== null) {
			metrics.probeSuccess.set(target, 0);
			metrics.nodePeers.remove(httpTransport);
			metrics.nodeIsSyncing.remove(httpTransport);
			return retryAfter(header);
		}

		const health = await rpcCall(network.rpcHttp, "system_health");
		if (stopped) return null;
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
		return retryAfter(health);
	};

	/**
	 * Genesis requests count in probe_total and probe_duration, but not in probe_success, which
	 * describes the 30 s head/health cycle. A failed check keeps the last genesis_match value: it
	 * is identity, re-evaluated on the next check, and removing it would silence
	 * FlopGenesisMismatch during an outage.
	 */
	const genesis = async (): Promise<number | null> => {
		const outcome = await rpcCall(network.rpcHttp, "chain_getBlockHash", [0]);
		if (stopped) return null;
		const hash =
			outcome.result === "ok" && typeof outcome.value === "string" && GENESIS_RE.test(outcome.value)
				? outcome.value
				: null;
		record("chain_getBlockHash", outcome, hash !== null, "genesis");
		if (hash !== null) {
			metrics.genesisMatch.set(
				{ ...byNetwork, source: "rpc_http" },
				hash === network.expectedGenesis ? 1 : 0,
			);
		}
		return retryAfter(outcome);
	};

	const loops = [
		startLoop(`${network.name} rpc_http`, RPC_HTTP_INTERVAL_MS, paced(headAndHealth), options),
		startLoop(`${network.name} genesis`, GENESIS_INTERVAL_MS, paced(genesis), options),
	];
	return {
		stop: async () => {
			stopped = true;
			await Promise.all(loops.map((loop) => loop.stop()));
		},
	};
}

/** Faucet /health answers 503 with its usual JSON body when degraded (architecture §6). */
const isHealthAnswer = (status: number) =>
	(status >= 200 && status < 300) || (status >= 500 && status < 600);

/**
 * The faucet probes of one network (architecture §4, §6): GET /limits, /health and /chain, each in
 * its own loop every 60 s. The three share one Retry-After pause, because they hit the same host.
 * Values come from the tolerant parsers: a missing or retyped field drops its series and counts in
 * flopwatch_schema_mismatch_total, and a failed request drops every value series of its target.
 */
export function startFaucetProbes(
	options: { network: NetworkConfig; faucetUrl: string; metrics: Metrics } & LoopOptions,
): ProbeLoop {
	const { network, faucetUrl, metrics, log } = options;
	const paced = sharedPause(options.now ?? (() => performance.now()));
	const byNetwork = { network: network.name };
	let stopped = false;

	/** Records one request of `target`, with the allowlisted fields its body lacked. */
	const record = (target: Target, outcome: HttpOutcome, mismatches: readonly string[]) => {
		const labels = { ...byNetwork, target };
		metrics.probeTotal.inc({ ...labels, result: outcome.result });
		metrics.probeDuration.observe(labels, outcome.ms / 1000);
		for (const field of mismatches) metrics.schemaMismatch.inc({ ...labels, field });
		metrics.probeSuccess.set(labels, outcome.result === "ok" ? 1 : 0);
		if (outcome.result === "ok") {
			metrics.probeLastSuccess.set(labels, Date.now() / 1000);
		} else {
			log.warn("faucet request failed", {
				network: network.name,
				target,
				result: outcome.result,
				error: outcome.error,
			});
		}
	};
	/** Sets a per-network value, or removes its series while the value is unknown. */
	const put = (gauge: Gauge<"network">, value: number | boolean | null) => {
		if (value === null) gauge.remove(byNetwork);
		else gauge.set(byNetwork, Number(value));
	};

	const limits = async (): Promise<number | null> => {
		const outcome = await getJson(`${faucetUrl}/limits`);
		if (stopped) return null;
		const parsed = outcome.result === "ok" ? parseFaucetLimits(outcome.value) : null;
		record("faucet_limits", outcome, parsed?.mismatches ?? []);
		const v = parsed?.value;
		const current = v?.status ?? null;
		for (const status of FAUCET_STATUSES) {
			const labels = { ...byNetwork, status };
			if (current === null) metrics.faucetStatus.remove(labels);
			else metrics.faucetStatus.set(labels, status === current ? 1 : 0);
		}
		put(metrics.faucetStale, v?.stale ?? null);
		put(metrics.faucetLimitsAsOf, v?.asOfSeconds ?? null);
		put(metrics.faucetBalance, v?.balanceFlop ?? null);
		put(metrics.faucetMinBalance, v?.minBalanceFlop ?? null);
		put(metrics.faucetDailyCapLimit, v?.dailyCapLimitFlop ?? null);
		put(metrics.faucetDailyCapUsed, v?.dailyCapUsedFlop ?? null);
		put(metrics.faucetDailyCapRemaining, v?.dailyCapRemainingFlop ?? null);
		put(metrics.faucetPendingGrants, v?.pendingGrants ?? null);
		for (const lane of SPONSOR_LANES) {
			const laneStatus = v?.sponsorStatus[lane] ?? null;
			for (const status of SPONSOR_STATUSES) {
				const labels = { ...byNetwork, lane, status };
				if (laneStatus === null) metrics.faucetSponsorStatus.remove(labels);
				else metrics.faucetSponsorStatus.set(labels, status === laneStatus ? 1 : 0);
			}
		}
		return retryAfter(outcome);
	};

	/** The status code is measured on every response, including failures. */
	const health = async (): Promise<number | null> => {
		const outcome = await getJson(`${faucetUrl}/health`, { accept: isHealthAnswer });
		if (stopped) return null;
		const parsed = outcome.result === "ok" ? parseFaucetHealth(outcome.value) : null;
		record("faucet_health", outcome, parsed?.mismatches ?? []);
		put(metrics.faucetHealthStatusCode, outcome.httpStatus);
		const v = parsed?.value;
		put(metrics.faucetHealthReady, v?.ready ?? null);
		for (const dependency of FAUCET_DEPENDENCIES) {
			const labels = { ...byNetwork, dependency };
			const ok = v?.dependencyOk[dependency] ?? null;
			if (ok === null) metrics.faucetDependencyOk.remove(labels);
			else metrics.faucetDependencyOk.set(labels, ok ? 1 : 0);
		}
		put(metrics.faucetIndexerLag, v?.indexerLagBlocks ?? null);
		return retryAfter(outcome);
	};

	/**
	 * The genesis is why /chain is read: without a valid one the probe fails, as the official UI's
	 * check does. genesis_match is identity, kept until the next successful check (architecture §5).
	 */
	const chain = async (): Promise<number | null> => {
		const fetched = await getJson(`${faucetUrl}/chain`);
		if (stopped) return null;
		const parsed = fetched.result === "ok" ? parseFaucetChain(fetched.value) : null;
		const hash = parsed?.value.genesisHash ?? null;
		const outcome: HttpOutcome =
			fetched.result === "ok" && hash === null
				? {
						result: "invalid_response",
						error: "no valid genesisHash",
						ms: fetched.ms,
						httpStatus: fetched.httpStatus,
						retryAfterMs: null,
					}
				: fetched;
		record("faucet_chain", outcome, parsed?.mismatches ?? []);
		if (hash !== null) {
			metrics.genesisMatch.set(
				{ ...byNetwork, source: "faucet" },
				hash === network.expectedGenesis ? 1 : 0,
			);
		}
		return retryAfter(outcome);
	};

	const loops = [
		startLoop(`${network.name} faucet_limits`, FAUCET_INTERVAL_MS, paced(limits), options),
		startLoop(`${network.name} faucet_health`, FAUCET_INTERVAL_MS, paced(health), options),
		startLoop(`${network.name} faucet_chain`, FAUCET_INTERVAL_MS, paced(chain), options),
	];
	return {
		stop: async () => {
			stopped = true;
			await Promise.all(loops.map((loop) => loop.stop()));
		},
	};
}
