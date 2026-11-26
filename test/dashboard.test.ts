import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildDashboard } from "../grafana/dashboard.ts";
import { createMetrics } from "../src/metrics.ts";

interface Target {
	readonly expr: string;
}
interface Panel {
	readonly type: string;
	readonly title: string;
	readonly description?: string;
	readonly collapsed?: boolean;
	readonly gridPos: { x: number; y: number; w: number; h: number };
	readonly targets?: readonly Target[];
	readonly panels?: readonly Panel[];
}
interface Dashboard {
	readonly uid: string;
	readonly title: string;
	readonly timezone: string;
	readonly refresh: string;
	readonly editable: boolean;
	readonly graphTooltip: number;
	readonly time: { from: string; to: string };
	readonly timepicker: { refresh_intervals: readonly string[] };
	readonly templating: {
		list: ReadonlyArray<{
			name: string;
			type: string;
			definition: string;
			multi: boolean;
			includeAll: boolean;
			current: { value: string };
		}>;
	};
	readonly annotations: { list: ReadonlyArray<{ name: string; expr?: string }> };
	readonly panels?: readonly Panel[];
}

const file = new URL("../grafana/dashboards/flop-watch-overview.json", import.meta.url);
const dashboard: Partial<Dashboard> = JSON.parse(readFileSync(file, "utf8"));

/** The dashboard's rows in order, each with its state and its panels' titles. */
function rows(panels: readonly Panel[]) {
	const result: Array<{ title: string; collapsed: boolean; panels: Panel[] }> = [
		{ title: "(top)", collapsed: false, panels: [] },
	];
	for (const panel of panels) {
		if (panel.type === "row") {
			result.push({
				title: panel.title,
				collapsed: panel.collapsed === true,
				panels: [...(panel.panels ?? [])],
			});
		} else {
			result.at(-1)?.panels.push(panel);
		}
	}
	return result;
}
const allPanels = rows(dashboard.panels ?? []).flatMap((row) => row.panels);

describe("flop-watch-overview dashboard (docs/dashboard.md)", () => {
	it("is the committed output of grafana/dashboard.ts (run `pnpm dashboard`)", () => {
		assert.deepEqual(dashboard, JSON.parse(JSON.stringify(buildDashboard())));
	});

	it("has the settings of §2", () => {
		assert.equal(dashboard.uid, "flop-watch-overview");
		assert.equal(dashboard.title, "FLOP Network health — flop-watch");
		assert.equal(dashboard.timezone, "utc");
		assert.equal(dashboard.refresh, "1m");
		assert.deepEqual(dashboard.time, { from: "now-24h", to: "now" });
		assert.equal(dashboard.timepicker?.refresh_intervals[0], "30s");
		assert.equal(dashboard.graphTooltip, 1, "shared crosshair");
		assert.equal(dashboard.editable, false, "the provisioned file is the source");
		const [network] = dashboard.templating?.list ?? [];
		assert.equal(network?.name, "network");
		assert.equal(network?.type, "query");
		assert.equal(network?.definition, "label_values(flopwatch_probe_total, network)");
		assert.equal(network?.multi, false);
		assert.equal(network?.includeAll, false);
		assert.equal(network?.current.value, "testnet");
		assert.deepEqual(
			dashboard.annotations?.list.map((a) => [a.name, a.expr]),
			[
				[
					"Runtime upgrade",
					'ALERTS{alertname="FlopRuntimeUpgraded", alertstate="firing", network="$network"}',
				],
			],
		);
	});

	it("has the rows and panels of §4 and §5, in order", () => {
		assert.deepEqual(
			rows(dashboard.panels ?? []).map((row) => ({
				row: row.title,
				collapsed: row.collapsed,
				panels: row.panels.map((p) => p.title),
			})),
			[
				{ row: "(top)", collapsed: false, panels: ["About"] },
				{
					row: "Now",
					collapsed: false,
					panels: [
						"RPC WebSocket",
						"RPC HTTP",
						"Best head age",
						"Finality lag",
						"Faucet claims",
						"Faucet status",
						"Explorer",
						"Genesis",
					],
				},
				{
					row: "Incidents",
					collapsed: false,
					panels: ["Incidents", "Firing now", "Last successful probe"],
				},
				{
					row: "RPC",
					collapsed: false,
					panels: [
						"RPC availability",
						"RPC latency",
						"RPC failures",
						"WebSocket reconnects",
						"Node peers and syncing",
					],
				},
				{
					row: "Blocks and finality",
					collapsed: false,
					panels: [
						"Heads now",
						"Finality lag",
						"Head age",
						"Block interval",
						"Skipped and rewound heads",
					],
				},
				{
					row: "Faucet",
					collapsed: false,
					panels: [
						"Claims ready",
						"Faucet probes",
						"Status",
						"Sponsor lanes",
						"Balance",
						"Daily cap",
						"Pending grants",
						"/health",
						"Dependencies",
						"Indexer lag (faucet)",
						"/limits data age",
						"Response time",
					],
				},
				{
					row: "Explorer",
					collapsed: false,
					panels: ["Explorer probe", "Indexer lag (explorer)", "Finality view (explorer)"],
				},
				{
					row: "Identity",
					collapsed: true,
					panels: ["Chain identity", "Genesis match", "Runtime version", "Slot duration"],
				},
				{
					row: "Collector",
					collapsed: true,
					panels: ["Version", "Requests to FLOP", "Memory", "Schema mismatches"],
				},
			],
		);
	});

	it("fills every grid line of every row exactly, with no overlap", () => {
		assert.ok(allPanels.length > 0, "the dashboard has panels");
		for (const row of rows(dashboard.panels ?? [])) {
			const lines = new Map<number, Panel[]>();
			for (const panel of row.panels) {
				lines.set(panel.gridPos.y, [...(lines.get(panel.gridPos.y) ?? []), panel]);
			}
			for (const [y, line] of lines) {
				let x = 0;
				for (const panel of line.toSorted((a, b) => a.gridPos.x - b.gridPos.x)) {
					assert.equal(panel.gridPos.x, x, `${row.title} y=${y}: ${panel.title} starts at ${x}`);
					x += panel.gridPos.w;
				}
				assert.equal(x, 24, `${row.title} y=${y} is 24 columns wide`);
			}
		}
	});

	it("starts every panel description with its category and source", () => {
		assert.ok(allPanels.length > 0, "the dashboard has panels");
		for (const panel of allPanels) {
			if (panel.type === "text") continue;
			assert.match(
				panel.description ?? "",
				/^(Measured|Reported|Derived|Self)\b[^·]* · \S/,
				panel.title,
			);
		}
	});

	it("queries only the collector's metrics, the §7 recording rules and Prometheus's own", () => {
		const known = new Set(
			createMetrics({ defaultMetrics: false })
				.registry.getMetricsAsArray()
				.flatMap((m) => [m.name, `${m.name}_bucket`, `${m.name}_count`, `${m.name}_sum`]),
		);
		const rules = readFileSync(
			new URL("../prometheus/rules/flop-watch.rules.yml", import.meta.url),
			"utf8",
		);
		for (const [, name] of rules.matchAll(/record: (\S+)/g)) if (name) known.add(name);
		known.add("ALERTS");
		known.add("process_resident_memory_bytes");

		assert.ok(allPanels.length > 0, "the dashboard has panels");
		for (const panel of allPanels) {
			for (const { expr } of panel.targets ?? []) {
				for (const [name] of expr.matchAll(/\b(flopwatch[:_][a-z0-9_:]+|ALERTS|process_\w+)/g)) {
					assert.ok(known.has(name), `${panel.title}: unknown series ${name}`);
				}
			}
		}
	});

	it("selects the chosen network in every series selector, except the collector's own", () => {
		assert.ok(allPanels.length > 0, "the dashboard has panels");
		for (const panel of allPanels) {
			for (const { expr } of panel.targets ?? []) {
				for (const [selector, name] of expr.matchAll(
					/\b(flopwatch[:_][a-z0-9_:]+|ALERTS)(\{[^}]*\})?/g,
				)) {
					if (name === "flopwatch_build_info") continue;
					assert.match(selector, /\{[^}]*network=~?"\$network\|?"/, `${panel.title}: ${selector}`);
				}
			}
		}
	});
});
