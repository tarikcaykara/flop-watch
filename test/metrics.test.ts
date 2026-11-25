import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMetrics } from "../src/metrics.ts";

describe("createMetrics", () => {
	const { registry } = createMetrics({ defaultMetrics: false });
	const metrics = registry.getMetricsAsArray();

	it("prefixes every collector metric with flopwatch_", () => {
		assert.ok(metrics.length > 0);
		for (const { name } of metrics) assert.match(name, /^flopwatch_[a-z_]+$/);
	});

	it("labels every metric as measured, reported or self, never derived (hard rule 5)", () => {
		for (const { name, help } of metrics) {
			assert.match(help, /^(measured|reported|self): /, name);
		}
	});

	it("adds the default process metrics only when asked", () => {
		const withDefaults = createMetrics().registry.getMetricsAsArray();
		assert.ok(withDefaults.some(({ name }) => name === "process_cpu_seconds_total"));
		assert.ok(!metrics.some(({ name }) => name === "process_cpu_seconds_total"));
	});
});
