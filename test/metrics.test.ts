import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMetrics } from "../src/metrics.ts";

// The metric contract of docs/architecture.md §6: name → label names.
const EXPECTED: Record<string, string[]> = {
	flopwatch_probe_success: ["network", "target"],
	flopwatch_probe_duration_seconds: ["network", "target"],
	flopwatch_probe_total: ["network", "target", "result"],
	flopwatch_probe_last_success_timestamp_seconds: ["network", "target"],
	flopwatch_ws_connected: ["network"],
	flopwatch_ws_connects_total: ["network"],
	flopwatch_ws_disconnects_total: ["network", "reason"],
	flopwatch_chain_best_block_number: ["network"],
	flopwatch_chain_finalized_block_number: ["network"],
	flopwatch_chain_best_head_received_timestamp_seconds: ["network"],
	flopwatch_chain_finalized_head_received_timestamp_seconds: ["network"],
	flopwatch_ws_head_skipped_blocks_total: ["network"],
	flopwatch_ws_head_rewinds_total: ["network"],
	flopwatch_chain_block_interval_seconds: ["network"],
	flopwatch_chain_slot_duration_seconds: ["network"],
	flopwatch_chain_info: ["network", "chain", "spec_name", "genesis_hash"],
	flopwatch_runtime_spec_version: ["network"],
	flopwatch_genesis_match: ["network", "source"],
	flopwatch_rpc_node_peers: ["network", "transport"],
	flopwatch_rpc_node_is_syncing: ["network", "transport"],
	flopwatch_rpc_http_best_block_number: ["network"],
	flopwatch_faucet_status: ["network", "status"],
	flopwatch_faucet_stale: ["network"],
	flopwatch_faucet_limits_as_of_timestamp_seconds: ["network"],
	flopwatch_faucet_balance_flop: ["network"],
	flopwatch_faucet_min_balance_flop: ["network"],
	flopwatch_faucet_daily_cap_limit_flop: ["network"],
	flopwatch_faucet_daily_cap_used_flop: ["network"],
	flopwatch_faucet_daily_cap_remaining_flop: ["network"],
	flopwatch_faucet_pending_grants: ["network"],
	flopwatch_faucet_sponsor_status: ["network", "lane", "status"],
	flopwatch_faucet_health_ready: ["network"],
	flopwatch_faucet_health_http_status_code: ["network"],
	flopwatch_faucet_dependency_ok: ["network", "dependency"],
	flopwatch_faucet_indexer_lag_blocks: ["network"],
	flopwatch_explorer_latest_block_number: ["network"],
	flopwatch_explorer_finalized_lag_blocks: ["network"],
	flopwatch_explorer_safe_mode: ["network"],
	flopwatch_schema_mismatch_total: ["network", "target", "field"],
	flopwatch_build_info: ["version"],
};

/** The `le` bounds a histogram exposes after one observation, without +Inf. */
async function buckets(text: Promise<string>): Promise<number[]> {
	return [...(await text).matchAll(/le="([^"]+)"/g)]
		.map((m) => m[1] ?? "")
		.filter((le) => le !== "+Inf")
		.map(Number);
}

describe("createMetrics", () => {
	it("registers exactly the metric families and label names of architecture §6", () => {
		const { registry } = createMetrics({ defaultMetrics: false });
		const actual = Object.fromEntries(
			registry.getMetricsAsArray().map((metric) => {
				const labelNames: unknown = Reflect.get(metric, "labelNames");
				assert.ok(Array.isArray(labelNames), metric.name);
				return [metric.name, [...labelNames]];
			}),
		);
		assert.deepEqual(actual, EXPECTED);
	});

	it("labels every metric as measured, reported or self, never derived (hard rule 5)", () => {
		const { registry } = createMetrics({ defaultMetrics: false });
		for (const { name, help } of registry.getMetricsAsArray()) {
			assert.match(help, /^(measured|reported|self): /, name);
		}
	});

	it("uses the histogram buckets of architecture §6", async () => {
		const metrics = createMetrics({ defaultMetrics: false });
		metrics.probeDuration.observe({ network: "testnet", target: "rpc_ws" }, 0.2);
		metrics.blockInterval.observe({ network: "testnet" }, 1);
		const text = (name: string) => metrics.registry.getSingleMetricAsString(name);
		assert.deepEqual(
			await buckets(text("flopwatch_probe_duration_seconds")),
			[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
		);
		assert.deepEqual(
			await buckets(text("flopwatch_chain_block_interval_seconds")),
			[0.5, 1, 1.5, 2, 3, 5, 10, 30, 60],
		);
	});

	it("adds the default process metrics only when asked", () => {
		const names = (defaultMetrics: boolean) =>
			createMetrics({ defaultMetrics })
				.registry.getMetricsAsArray()
				.map(({ name }) => name);
		assert.ok(names(true).includes("process_cpu_seconds_total"));
		assert.ok(!names(false).includes("process_cpu_seconds_total"));
	});
});
