// Every metric flop-watch exports, in one place (architecture §6). Help texts start with the
// signal category: "measured" (observed by flop-watch), "reported" (stated by a FLOP service or
// node) or "self" (about the collector). Derived signals live only in Prometheus rules.

import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { VERSION } from "./version.ts";

export const TARGETS = [
	"rpc_ws",
	"rpc_http",
	"faucet_limits",
	"faucet_health",
	"faucet_chain",
	"explorer_stats",
] as const;
export type Target = (typeof TARGETS)[number];

export const PROBE_RESULTS = [
	"ok",
	"timeout",
	"network_error",
	"http_error",
	"rpc_error",
	"invalid_response",
	"rate_limited",
] as const;
export type ProbeResult = (typeof PROBE_RESULTS)[number];

export const TRANSPORTS = ["ws", "http"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const DISCONNECT_REASONS = ["close", "error", "stall_timeout"] as const;
export type DisconnectReason = (typeof DISCONNECT_REASONS)[number];

export const GENESIS_SOURCES = ["rpc_ws", "rpc_http", "faucet"] as const;
export type GenesisSource = (typeof GENESIS_SOURCES)[number];

export const FAUCET_STATUSES = ["open", "low_balance", "unknown", "other"] as const;
export type FaucetStatus = (typeof FAUCET_STATUSES)[number];

export const SPONSOR_LANES = ["miner", "validator"] as const;
export type SponsorLane = (typeof SPONSOR_LANES)[number];

export const SPONSOR_STATUSES = [
	"open",
	"automatic_full",
	"positions_full",
	"unknown",
	"other",
] as const;
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];

export const FAUCET_DEPENDENCIES = [
	"signer",
	"indexer",
	"ip_classification",
	"funding",
	"signing",
] as const;
export type FaucetDependency = (typeof FAUCET_DEPENDENCIES)[number];

/** The only label names allowed (hard rule 4); the type keeps any other name from compiling. */
type LabelName =
	| "network"
	| "target"
	| "result"
	| "transport"
	| "reason"
	| "source"
	| "chain"
	| "spec_name"
	| "genesis_hash"
	| "status"
	| "lane"
	| "dependency"
	| "field"
	| "version";

const PROBE_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const BLOCK_INTERVAL_BUCKETS = [0.5, 1, 1.5, 2, 3, 5, 10, 30, 60];

type ByNetwork = "network";

/** The collector's metrics; each field's label names are part of the contract. */
export interface Metrics {
	readonly registry: Registry;
	readonly probeSuccess: Gauge<ByNetwork | "target">;
	readonly probeDuration: Histogram<ByNetwork | "target">;
	readonly probeTotal: Counter<ByNetwork | "target" | "result">;
	readonly probeLastSuccess: Gauge<ByNetwork | "target">;
	readonly wsConnected: Gauge<ByNetwork>;
	readonly wsConnects: Counter<ByNetwork>;
	readonly wsDisconnects: Counter<ByNetwork | "reason">;
	readonly bestBlock: Gauge<ByNetwork>;
	readonly finalizedBlock: Gauge<ByNetwork>;
	readonly bestHeadReceived: Gauge<ByNetwork>;
	readonly finalizedHeadReceived: Gauge<ByNetwork>;
	readonly headSkippedBlocks: Counter<ByNetwork>;
	readonly headRewinds: Counter<ByNetwork>;
	readonly blockInterval: Histogram<ByNetwork>;
	readonly slotDuration: Gauge<ByNetwork>;
	readonly chainInfo: Gauge<ByNetwork | "chain" | "spec_name" | "genesis_hash">;
	readonly specVersion: Gauge<ByNetwork>;
	readonly genesisMatch: Gauge<ByNetwork | "source">;
	readonly nodePeers: Gauge<ByNetwork | "transport">;
	readonly nodeIsSyncing: Gauge<ByNetwork | "transport">;
	readonly httpBestBlock: Gauge<ByNetwork>;
	readonly faucetStatus: Gauge<ByNetwork | "status">;
	readonly faucetStale: Gauge<ByNetwork>;
	readonly faucetLimitsAsOf: Gauge<ByNetwork>;
	readonly faucetBalance: Gauge<ByNetwork>;
	readonly faucetMinBalance: Gauge<ByNetwork>;
	readonly faucetDailyCapLimit: Gauge<ByNetwork>;
	readonly faucetDailyCapUsed: Gauge<ByNetwork>;
	readonly faucetDailyCapRemaining: Gauge<ByNetwork>;
	readonly faucetPendingGrants: Gauge<ByNetwork>;
	readonly faucetSponsorStatus: Gauge<ByNetwork | "lane" | "status">;
	readonly faucetHealthReady: Gauge<ByNetwork>;
	readonly faucetHealthStatusCode: Gauge<ByNetwork>;
	readonly faucetDependencyOk: Gauge<ByNetwork | "dependency">;
	readonly faucetIndexerLag: Gauge<ByNetwork>;
	readonly explorerLatestBlock: Gauge<ByNetwork>;
	readonly explorerFinalizedLag: Gauge<ByNetwork>;
	readonly explorerSafeMode: Gauge<ByNetwork>;
	readonly schemaMismatch: Counter<ByNetwork | "target" | "field">;
}

export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
	const registry = new Registry();
	const registers = [registry];
	const gauge = <L extends LabelName>(name: string, help: string, labelNames: readonly L[]) =>
		new Gauge<L>({ name, help, labelNames, registers });
	const counter = <L extends LabelName>(name: string, help: string, labelNames: readonly L[]) =>
		new Counter<L>({ name, help, labelNames, registers });
	const histogram = <L extends LabelName>(
		name: string,
		help: string,
		labelNames: readonly L[],
		buckets: number[],
	) => new Histogram<L>({ name, help, labelNames, buckets, registers });

	const metrics: Metrics = {
		registry,

		// Probes
		probeSuccess: gauge(
			"flopwatch_probe_success",
			"measured: 1 if the last probe of the target succeeded, else 0.",
			["network", "target"],
		),
		probeDuration: histogram(
			"flopwatch_probe_duration_seconds",
			"measured: Duration of probe requests.",
			["network", "target"],
			PROBE_BUCKETS,
		),
		probeTotal: counter("flopwatch_probe_total", "measured: Probe requests by result.", [
			"network",
			"target",
			"result",
		]),
		probeLastSuccess: gauge(
			"flopwatch_probe_last_success_timestamp_seconds",
			"measured: Unix time of the last successful probe of the target.",
			["network", "target"],
		),

		// WebSocket
		wsConnected: gauge(
			"flopwatch_ws_connected",
			"measured: 1 while the RPC WebSocket is open and subscribed, else 0.",
			["network"],
		),
		wsConnects: counter(
			"flopwatch_ws_connects_total",
			"measured: RPC WebSocket connections opened.",
			["network"],
		),
		wsDisconnects: counter(
			"flopwatch_ws_disconnects_total",
			"measured: RPC WebSocket disconnections by reason.",
			["network", "reason"],
		),

		// Chain heads
		bestBlock: gauge(
			"flopwatch_chain_best_block_number",
			"reported: Best block number from the new-heads subscription.",
			["network"],
		),
		finalizedBlock: gauge(
			"flopwatch_chain_finalized_block_number",
			"reported: Finalized block number from the finalized-heads subscription.",
			["network"],
		),
		bestHeadReceived: gauge(
			"flopwatch_chain_best_head_received_timestamp_seconds",
			"measured: Unix time the last new-head notification arrived.",
			["network"],
		),
		finalizedHeadReceived: gauge(
			"flopwatch_chain_finalized_head_received_timestamp_seconds",
			"measured: Unix time the last finalized-head notification arrived.",
			["network"],
		),
		headSkippedBlocks: counter(
			"flopwatch_ws_head_skipped_blocks_total",
			"measured: Blocks skipped between consecutive new-head notifications.",
			["network"],
		),
		headRewinds: counter(
			"flopwatch_ws_head_rewinds_total",
			"measured: New-head notifications at or below the previous height.",
			["network"],
		),

		// Block interval
		blockInterval: histogram(
			"flopwatch_chain_block_interval_seconds",
			"reported: BABE slot delta between consecutive, parent-linked blocks, in seconds.",
			["network"],
			BLOCK_INTERVAL_BUCKETS,
		),
		slotDuration: gauge(
			"flopwatch_chain_slot_duration_seconds",
			"reported: BABE slot duration from BabeApi_configuration.",
			["network"],
		),

		// Identity
		chainInfo: gauge("flopwatch_chain_info", "reported: Chain identity; always 1.", [
			"network",
			"chain",
			"spec_name",
			"genesis_hash",
		]),
		specVersion: gauge("flopwatch_runtime_spec_version", "reported: Runtime specVersion.", [
			"network",
		]),
		genesisMatch: gauge(
			"flopwatch_genesis_match",
			"reported: 1 if the source's genesis hash equals the expected one, else 0.",
			["network", "source"],
		),

		// RPC node
		nodePeers: gauge(
			"flopwatch_rpc_node_peers",
			"reported: Peers of the RPC node that answered system_health.",
			["network", "transport"],
		),
		nodeIsSyncing: gauge(
			"flopwatch_rpc_node_is_syncing",
			"reported: 1 if the RPC node that answered system_health is syncing, else 0.",
			["network", "transport"],
		),
		httpBestBlock: gauge(
			"flopwatch_rpc_http_best_block_number",
			"reported: Best block number from chain_getHeader over HTTP.",
			["network"],
		),

		// Faucet
		faucetStatus: gauge(
			"flopwatch_faucet_status",
			"reported: Faucet /limits faucet.status as a state set (1 for the current status).",
			["network", "status"],
		),
		faucetStale: gauge(
			"flopwatch_faucet_stale",
			"reported: 1 if faucet /limits says its data is stale, else 0.",
			["network"],
		),
		faucetLimitsAsOf: gauge(
			"flopwatch_faucet_limits_as_of_timestamp_seconds",
			"reported: Unix time of faucet /limits asOf.",
			["network"],
		),
		faucetBalance: gauge("flopwatch_faucet_balance_flop", "reported: Faucet balance in FLOP.", [
			"network",
		]),
		faucetMinBalance: gauge(
			"flopwatch_faucet_min_balance_flop",
			"reported: Faucet minimum balance in FLOP.",
			["network"],
		),
		faucetDailyCapLimit: gauge(
			"flopwatch_faucet_daily_cap_limit_flop",
			"reported: Faucet daily cap in FLOP.",
			["network"],
		),
		faucetDailyCapUsed: gauge(
			"flopwatch_faucet_daily_cap_used_flop",
			"reported: Faucet daily cap used, in FLOP.",
			["network"],
		),
		faucetDailyCapRemaining: gauge(
			"flopwatch_faucet_daily_cap_remaining_flop",
			"reported: Faucet daily cap remaining, in FLOP.",
			["network"],
		),
		faucetPendingGrants: gauge(
			"flopwatch_faucet_pending_grants",
			"reported: Faucet pending grants.",
			["network"],
		),
		faucetSponsorStatus: gauge(
			"flopwatch_faucet_sponsor_status",
			"reported: Faucet sponsor lane status as a state set (1 for the current status).",
			["network", "lane", "status"],
		),
		faucetHealthReady: gauge(
			"flopwatch_faucet_health_ready",
			"reported: Faucet /health ready flag, scoped to the collector's own client.",
			["network"],
		),
		faucetHealthStatusCode: gauge(
			"flopwatch_faucet_health_http_status_code",
			"measured: HTTP status code of faucet /health.",
			["network"],
		),
		faucetDependencyOk: gauge(
			"flopwatch_faucet_dependency_ok",
			"reported: Faucet /health dependency ok flag.",
			["network", "dependency"],
		),
		faucetIndexerLag: gauge(
			"flopwatch_faucet_indexer_lag_blocks",
			"reported: Indexer lag reported by faucet /health, in blocks.",
			["network"],
		),

		// Explorer
		explorerLatestBlock: gauge(
			"flopwatch_explorer_latest_block_number",
			"reported: Latest block number indexed by the explorer.",
			["network"],
		),
		explorerFinalizedLag: gauge(
			"flopwatch_explorer_finalized_lag_blocks",
			"reported: Finality lag reported by the explorer, in blocks.",
			["network"],
		),
		explorerSafeMode: gauge(
			"flopwatch_explorer_safe_mode",
			"reported: 1 if the explorer reports finality safe mode, else 0.",
			["network"],
		),

		// Self
		schemaMismatch: counter(
			"flopwatch_schema_mismatch_total",
			"self: Remote fields that were missing or had an unexpected type.",
			["network", "target", "field"],
		),
	};

	gauge("flopwatch_build_info", "self: Collector version; always 1.", ["version"]).set(
		{ version: VERSION },
		1,
	);
	if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });
	return metrics;
}

/**
 * Creates a probe target's counters and duration histogram at 0 (dashboard.md §3): `increase()`
 * cannot see a counter's first event when its series first appears at 1. `results` and `fields`
 * are what the target can report.
 */
export function zeroTargetSeries(
	metrics: Metrics,
	labels: { readonly network: string; readonly target: Target },
	results: readonly ProbeResult[],
	fields: readonly string[],
): void {
	for (const result of results) metrics.probeTotal.inc({ ...labels, result }, 0);
	for (const field of fields) metrics.schemaMismatch.inc({ ...labels, field }, 0);
	metrics.probeDuration.zero(labels);
}
