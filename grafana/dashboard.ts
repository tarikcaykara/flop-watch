// Builds the flop-watch-overview dashboard of docs/dashboard.md as provisioned Grafana JSON.
// After a change, run `pnpm dashboard`; test/dashboard.test.ts keeps the committed file equal to
// this output. Panel IDs (N1, F3, …) in the comments are the spec's.

import { writeFileSync } from "node:fs";

/** A JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const DS: Obj = { type: "prometheus", uid: "prometheus" };
const REPO = "https://github.com/tarikcaykara/flop-watch";

// Colours (§3): green healthy, orange degraded or warning, red down or critical, blue and grey
// neutral information.
const GREEN = "green";
const ORANGE = "orange";
const RED = "red";
const BLUE = "blue";
const GREY = "#8e8e8e";
const NONE = "transparent";

const BLOCKS = "suffix: blocks";

/** A selector of the chosen network, with optional extra matchers. */
const sel = (metric: string, extra = "") =>
	`${metric}{network="$network"${extra === "" ? "" : `, ${extra}`}}`;

// The display encodings of the state sets (§3).
const FAUCET_STATUS_CODE = ["open", "low_balance", "unknown", "other"]
	.map((status, i) => {
		const sum = `sum(${sel("flopwatch_faucet_status", `status="${status}"`)})`;
		return i === 0 ? sum : `${i + 1} * ${sum}`;
	})
	.join("\n+ ");
const SPONSOR_CODE = ["open", "automatic_full", "positions_full", "unknown", "other"]
	.map((status, i) => {
		const sum = `sum by (lane) (${sel("flopwatch_faucet_sponsor_status", `status="${status}"`)})`;
		return i === 0 ? sum : `${i + 1} * ${sum}`;
	})
	.join("\n+ ");
const firing = (severity: string) =>
	`max by (alertname) (ALERTS{alertstate="firing", severity="${severity}", network=~"$network|"})`;
// With nothing firing, a "No incident" row keeps the timeline from rendering an empty frame,
// which Grafana reports as "Data does not have a time field". The row needs flop-watch's scrape
// series, so a time with no data at all stays empty instead of green.
const INCIDENTS = [
	`3 * ${firing("critical")}`,
	`2 * ${firing("warning")}`,
	firing("info"),
	'on() label_replace(vector(0) and on() count(up{job="flop-watch"}), "alertname", "No incident", "", "")',
].join("\nor ");

/** Value mappings: each value shows as its text, in its colour. */
function values(...entries: Array<[number, string, string]>): Json {
	return {
		type: "value",
		options: Object.fromEntries(
			entries.map(([value, text, color], index) => [String(value), { text, color, index }]),
		),
	};
}
const UP_DOWN = [values([1, "Up", GREEN], [0, "Down", RED])];
const READY = [values([1, "Ready", GREEN], [0, "Not ready", RED])];
const FAUCET_STATUS = [
	values([1, "open", GREEN], [2, "low_balance", RED], [3, "unknown", ORANGE], [4, "other", GREY]),
];
const SPONSOR_STATUS = [
	values(
		[1, "open", GREEN],
		[2, "automatic_full", BLUE],
		[3, "positions_full", ORANGE],
		[4, "unknown", RED],
		[5, "other", GREY],
	),
];
const HTTP_STATUS: Json[] = [
	values([503, "503 degraded", ORANGE]),
	{ type: "range", options: { from: 200, to: 299, result: { color: GREEN, index: 1 } } },
	{ type: "range", options: { from: 0, to: 999, result: { color: RED, index: 2 } } },
];

/** Threshold steps: a base colour, then `[from, colour]` pairs. */
function steps(base: string, ...rest: Array<[number, string]>): Obj {
	return {
		mode: "absolute",
		steps: [{ color: base, value: null }, ...rest.map(([value, color]) => ({ color, value }))],
	};
}

interface Query {
	readonly expr: string;
	readonly legend?: string;
	/** The latest value only: for stats and tables. */
	readonly instant?: boolean;
	readonly format?: "table" | "heatmap";
}
function targets(queries: readonly Query[]): Json[] {
	return queries.map((q, i) => ({
		refId: String.fromCharCode(65 + i),
		datasource: DS,
		expr: q.expr,
		legendFormat: q.legend ?? "__auto",
		...(q.instant === true ? { instant: true, range: false } : { instant: false, range: true }),
		...(q.format === undefined ? {} : { format: q.format }),
	}));
}

/** A panel before layout: its size, and everything but its position and ID. */
interface Spec {
	readonly w: number;
	readonly h: number;
	readonly body: Obj;
}
interface Common {
	readonly title: string;
	readonly description: string;
	readonly w: number;
	readonly h: number;
	readonly queries: readonly Query[];
}
/** A field override that applies `properties` to the series `matcher` selects. */
function override(matcher: Obj, properties: Obj): Json {
	return { matcher, properties: Object.entries(properties).map(([id, value]) => ({ id, value })) };
}
const byName = (name: string, properties: Obj) =>
	override({ id: "byName", options: name }, properties);

function stat(
	o: Common & {
		unit?: string;
		mappings?: Json[];
		thresholds?: Obj;
		textMode?: string;
		colorMode?: "background" | "none";
		displayName?: string;
	},
): Spec {
	return {
		w: o.w,
		h: o.h,
		body: {
			type: "stat",
			title: o.title,
			description: o.description,
			datasource: DS,
			targets: targets(o.queries),
			fieldConfig: {
				defaults: {
					unit: o.unit ?? "none",
					decimals: 0,
					noValue: "No data",
					mappings: o.mappings ?? [],
					thresholds: o.thresholds ?? steps(GREY),
					color: { mode: "thresholds" },
					...(o.displayName === undefined ? {} : { displayName: o.displayName }),
				},
				overrides: [],
			},
			options: {
				reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
				colorMode: o.colorMode ?? "background",
				graphMode: "none",
				textMode: o.textMode ?? "value",
				justifyMode: "center",
				orientation: "auto",
				wideLayout: true,
				showPercentChange: false,
			},
		},
	};
}

function timeline(o: Common & { mappings: Json[]; overrides?: Json[] }): Spec {
	return {
		w: o.w,
		h: o.h,
		body: {
			type: "state-timeline",
			title: o.title,
			description: o.description,
			datasource: DS,
			targets: targets(o.queries),
			fieldConfig: {
				defaults: {
					mappings: o.mappings,
					// Not "thresholds": with merged values, Grafana then shows threshold ranges and skips
					// the value mappings. Unmapped values stay grey.
					color: { mode: "fixed", fixedColor: GREY },
					// No insertNulls: Grafana then breaks a line at a missing sample of the query step, at
					// any time range; a fixed threshold would break every line once the step is longer.
					custom: { fillOpacity: 80, lineWidth: 0, spanNulls: false },
				},
				overrides: o.overrides ?? [],
			},
			options: {
				mergeValues: true,
				showValue: "never",
				alignValue: "left",
				rowHeight: 0.85,
				legend: { showLegend: false, displayMode: "list", placement: "bottom" },
				tooltip: { mode: "multi", sort: "none" },
			},
		},
	};
}

function series(
	o: Common & {
		unit?: string;
		decimals?: number;
		thresholds?: Obj;
		bars?: boolean;
		stepped?: boolean;
		/** Instead of a unit suffix on every tick, for long amounts such as FLOP. */
		axisLabel?: string;
		overrides?: Json[];
	},
): Spec {
	const bars = o.bars === true;
	return {
		w: o.w,
		h: o.h,
		body: {
			type: "timeseries",
			title: o.title,
			description: o.description,
			datasource: DS,
			...(bars ? { interval: "1m" } : {}),
			targets: targets(o.queries),
			fieldConfig: {
				defaults: {
					unit: o.unit ?? "none",
					...(o.decimals === undefined ? {} : { decimals: o.decimals }),
					thresholds: o.thresholds ?? steps(NONE),
					color: { mode: "palette-classic" },
					custom: {
						drawStyle: bars ? "bars" : "line",
						lineInterpolation: o.stepped === true ? "stepAfter" : "linear",
						lineWidth: 1,
						fillOpacity: bars ? 80 : 0,
						showPoints: "never",
						spanNulls: false,
						stacking: { mode: bars ? "normal" : "none", group: "A" },
						thresholdsStyle: { mode: o.thresholds === undefined ? "off" : "line" },
						...(o.axisLabel === undefined ? {} : { axisLabel: o.axisLabel }),
					},
				},
				overrides: o.overrides ?? [],
			},
			options: {
				legend: { showLegend: true, displayMode: "list", placement: "bottom" },
				tooltip: { mode: "multi", sort: "none" },
			},
		},
	};
}

/** Bars on the right axis, from 0 to 1, for a 0/1 flag shown next to a count. */
const flagBars = { "custom.drawStyle": "bars", "custom.axisPlacement": "right", min: 0, max: 1 };
const dashed = { "custom.lineStyle": { fill: "dash", dash: [10, 10] } };

function table(
	o: Common & {
		columns: string[];
		rename?: Obj;
		/** A unit for one column only, so text columns stay text. */
		columnUnit?: { column: string; unit: string };
		decimals?: number;
	},
): Spec {
	return {
		w: o.w,
		h: o.h,
		body: {
			type: "table",
			title: o.title,
			description: o.description,
			datasource: DS,
			targets: targets(o.queries),
			transformations: [
				{ id: "filterFieldsByName", options: { include: { names: o.columns } } },
				{ id: "organize", options: { renameByName: o.rename ?? {} } },
			],
			fieldConfig: {
				defaults: {
					unit: "none",
					...(o.decimals === undefined ? {} : { decimals: o.decimals }),
					noValue: "No data",
					color: { mode: "thresholds" },
					thresholds: steps(GREY),
				},
				overrides:
					o.columnUnit === undefined
						? []
						: [byName(o.columnUnit.column, { unit: o.columnUnit.unit })],
			},
			options: { showHeader: true, cellHeight: "sm", footer: { show: false } },
		},
	};
}

// ---- Panels (docs/dashboard.md §5) ----

const CLAIMS_READY =
	"Derived · mirrors the Testnet faucet page's check (research §7): `/chain` and `/limits` " +
	"fetched, the faucet's genesis matches, `stale` is false and the status is `open`. Not " +
	"checked: the network names, which the genesis check covers, and the page's agent-lane " +
	"constants. The page itself checks only on load, so it can stay disabled after this recovers.";

const about: Spec = {
	w: 24,
	h: 4,
	body: {
		type: "text",
		title: "About",
		options: {
			mode: "markdown",
			content:
				"Independent, read-only monitor of FLOP Network Devnet and Testnet, from a single " +
				"vantage point. Not affiliated with FLOP Labs. **Measured**: observed by flop-watch. " +
				"**Reported**: stated by a FLOP node or service. **Derived**: computed by a rule from " +
				"other signals. **Self**: about flop-watch itself. Times are UTC. Source and method: " +
				`[github.com/tarikcaykara/flop-watch](${REPO}).`,
		},
	},
};

const now: Spec[] = [
	stat({
		title: "RPC WebSocket",
		description:
			"Measured · `system_health` over flop-watch's RPC WebSocket, every 30 s. Down means the " +
			"last attempt failed: the health call, the connection, or the setup after connecting.",
		w: 6,
		h: 4,
		queries: [{ expr: sel("flopwatch_probe_success", 'target="rpc_ws"'), instant: true }],
		mappings: UP_DOWN,
	}),
	stat({
		title: "RPC HTTP",
		description:
			"Measured · `chain_getHeader` and `system_health` over HTTP JSON-RPC, every 30 s. Down " +
			"means at least one of the two failed in the last cycle.",
		w: 6,
		h: 4,
		queries: [{ expr: sel("flopwatch_probe_success", 'target="rpc_http"'), instant: true }],
		mappings: UP_DOWN,
	}),
	stat({
		title: "Best head age",
		description:
			"Derived · time since flop-watch received the last new-head notification over the " +
			"WebSocket. Blocks come every second, so over 30 s means no new block reached us.",
		w: 6,
		h: 4,
		queries: [{ expr: sel("flopwatch:best_head_age_seconds"), instant: true }],
		unit: "s",
		thresholds: steps(GREEN, [10, ORANGE], [30, RED]),
	}),
	stat({
		title: "Finality lag",
		description:
			"Derived · best minus finalized block number, from the WebSocket subscriptions. 30 and " +
			"120 blocks are the yellowpaper's warning and freeze thresholds.",
		w: 6,
		h: 4,
		queries: [{ expr: sel("flopwatch:finality_lag_blocks"), instant: true }],
		unit: BLOCKS,
		thresholds: steps(GREEN, [30, ORANGE], [120, RED]),
	}),
	stat({
		title: "Faucet claims",
		description: CLAIMS_READY,
		w: 6,
		h: 4,
		queries: [{ expr: sel("flopwatch:faucet_claim_ready"), instant: true }],
		mappings: READY,
	}),
	stat({
		title: "Faucet status",
		description: "Reported · `faucet.status` from the faucet's `/limits`, every 60 s.",
		w: 6,
		h: 4,
		queries: [{ expr: FAUCET_STATUS_CODE, instant: true }],
		mappings: FAUCET_STATUS,
	}),
	stat({
		title: "Explorer",
		description:
			"Measured · GET `/api/stats` on the explorer, every 60 s. Down means the request failed " +
			"or did not return a JSON object.",
		w: 6,
		h: 4,
		queries: [{ expr: sel("flopwatch_probe_success", 'target="explorer_stats"'), instant: true }],
		mappings: UP_DOWN,
	}),
	stat({
		title: "Genesis",
		description:
			"Reported · the genesis hash from the RPC WebSocket, RPC HTTP and the faucet, against the " +
			"pinned one. A mismatch points to a network reset or an endpoint serving another chain; " +
			"the Identity row shows which source.",
		w: 6,
		h: 4,
		queries: [{ expr: `min(${sel("flopwatch_genesis_match")})`, instant: true }],
		mappings: [values([1, "Match", GREEN], [0, "Mismatch", RED])],
	}),
];

const incidents: Spec[][] = [
	[
		timeline({
			title: "Incidents",
			description:
				"Derived · Prometheus alert rules over flop-watch's signals. Each alert's category " +
				"(measured, reported, derived) is in the Firing now table.",
			w: 24,
			h: 8,
			queries: [{ expr: INCIDENTS, legend: "{{alertname}}" }],
			mappings: [
				values([3, "critical", RED], [2, "warning", ORANGE], [1, "info", BLUE], [0, "none", GREEN]),
			],
		}),
	],
	[
		table({
			title: "Firing now",
			description:
				"Derived · the alerts firing now, with the category of the signal each one reads.",
			w: 12,
			h: 6,
			queries: [
				{
					expr: 'ALERTS{alertstate="firing", network=~"$network|"}',
					instant: true,
					format: "table",
				},
			],
			columns: ["alertname", "severity", "category"],
		}),
		table({
			title: "Last successful probe",
			description:
				"Measured · when each probe last succeeded. A target missing here has not succeeded " +
				"since the collector started.",
			w: 12,
			h: 6,
			queries: [
				{
					expr: `${sel("flopwatch_probe_last_success_timestamp_seconds")} * 1000`,
					instant: true,
					format: "table",
				},
			],
			columns: ["target", "Value"],
			rename: { Value: "last success" },
			columnUnit: { column: "last success", unit: "dateTimeFromNow" },
		}),
	],
];

const latency = (quantile: number, label: string) => ({
	expr: `histogram_quantile(${quantile}, sum by (le, target) (rate(${sel(
		"flopwatch_probe_duration_seconds_bucket",
		'target=~"rpc_ws|rpc_http"',
	)}[5m])))`,
	legend: `{{target}} ${label}`,
});

const rpc: Spec[][] = [
	[
		timeline({
			title: "RPC availability",
			description:
				"Measured · flop-watch's WebSocket connection and its 30 s probes over the WebSocket " +
				"and HTTP. Gaps mean the collector was not running or Prometheus could not scrape it.",
			w: 12,
			h: 6,
			queries: [
				{ expr: sel("flopwatch_ws_connected"), legend: "WebSocket connected" },
				{ expr: sel("flopwatch_probe_success", 'target="rpc_ws"'), legend: "WebSocket probe" },
				{ expr: sel("flopwatch_probe_success", 'target="rpc_http"'), legend: "HTTP probe" },
			],
			mappings: UP_DOWN,
		}),
		series({
			title: "RPC latency",
			description:
				"Measured · response time of the RPC probes from one vantage point, including our " +
				"network path and the Cloudflare edge. HTTP includes the genesis check every 10 min.",
			w: 12,
			h: 6,
			queries: [latency(0.5, "p50"), latency(0.95, "p95")],
			unit: "s",
		}),
	],
	[
		series({
			title: "RPC failures",
			description:
				"Measured · failed RPC requests by result: timeout, network error, HTTP error, " +
				"JSON-RPC error, invalid response or rate limited.",
			w: 8,
			h: 6,
			queries: [
				{
					expr: `sum by (target, result) (increase(${sel(
						"flopwatch_probe_total",
						'target=~"rpc_ws|rpc_http", result!="ok"',
					)}[$__interval]))`,
					legend: "{{target}} {{result}}",
				},
			],
			bars: true,
			decimals: 0,
		}),
		series({
			title: "WebSocket reconnects",
			description:
				"Measured · WebSocket connections opened, and closed by reason: a remote close, an " +
				"error, or flop-watch's stall watchdog (no new head for 30 s).",
			w: 8,
			h: 6,
			queries: [
				{
					expr: `sum by (reason) (increase(${sel("flopwatch_ws_disconnects_total")}[$__interval]))`,
					legend: "disconnect: {{reason}}",
				},
				{
					expr: `increase(${sel("flopwatch_ws_connects_total")}[$__interval])`,
					legend: "connect",
				},
			],
			bars: true,
			decimals: 0,
		}),
		series({
			title: "Node peers and syncing",
			description:
				"Reported · peers and the syncing flag from `system_health`, of whichever RPC node " +
				"behind the load balancer answered. This describes that node, not the network.",
			w: 8,
			h: 6,
			queries: [
				{ expr: sel("flopwatch_rpc_node_peers"), legend: "peers ({{transport}})" },
				{ expr: sel("flopwatch_rpc_node_is_syncing"), legend: "syncing ({{transport}})" },
			],
			decimals: 0,
			overrides: [override({ id: "byRegexp", options: "^syncing" }, flagBars)],
		}),
	],
];

const blocks: Spec[][] = [
	[
		stat({
			title: "Heads now",
			description:
				"Reported · the latest block numbers from the WebSocket subscriptions, " +
				"`chain_getHeader` over HTTP and the explorer's `/api/stats`.",
			w: 24,
			h: 3,
			queries: [
				{
					expr: sel("flopwatch_chain_best_block_number"),
					legend: "Best (WebSocket)",
					instant: true,
				},
				{
					expr: sel("flopwatch_chain_finalized_block_number"),
					legend: "Finalized (WebSocket)",
					instant: true,
				},
				{ expr: sel("flopwatch_rpc_http_best_block_number"), legend: "Best (HTTP)", instant: true },
				{
					expr: sel("flopwatch_explorer_latest_block_number"),
					legend: "Explorer latest",
					instant: true,
				},
			],
			textMode: "value_and_name",
			colorMode: "none",
		}),
	],
	[
		series({
			title: "Finality lag",
			description:
				"Derived · best minus finalized block number. 30 and 120 blocks are the yellowpaper's " +
				"warning and freeze thresholds. Devnet can go negative, probably because its WebSocket " +
				"streams come from more than one backend.",
			w: 12,
			h: 7,
			queries: [{ expr: sel("flopwatch:finality_lag_blocks"), legend: "lag" }],
			unit: BLOCKS,
			decimals: 0,
			thresholds: steps(NONE, [0, GREY], [30, ORANGE], [120, RED]),
		}),
		series({
			title: "Head age",
			description:
				"Derived · time since the last new-head and finalized-head notifications reached " +
				"flop-watch. This reflects delivery to us, not block production.",
			w: 12,
			h: 7,
			queries: [
				{ expr: sel("flopwatch:best_head_age_seconds"), legend: "best" },
				{ expr: sel("flopwatch:finalized_head_age_seconds"), legend: "finalized" },
			],
			unit: "s",
			overrides: [
				byName("best", {
					thresholds: steps(NONE, [30, ORANGE]),
					"custom.thresholdsStyle": { mode: "line" },
				}),
				byName("finalized", {
					thresholds: steps(NONE, [120, RED]),
					"custom.thresholdsStyle": { mode: "line" },
				}),
			],
		}),
	],
	[
		{
			w: 12,
			h: 7,
			body: {
				type: "heatmap",
				title: "Block interval",
				description:
					"Reported · BABE slot delta times slot duration, between consecutive, parent-linked " +
					"blocks. 1 s is normal; anything higher means empty slots.",
				datasource: DS,
				interval: "1m",
				targets: targets([
					{
						expr: `sum by (le) (increase(${sel("flopwatch_chain_block_interval_seconds_bucket")}[$__interval]))`,
						legend: "{{le}}",
						format: "heatmap",
					},
				]),
				fieldConfig: { defaults: {}, overrides: [] },
				options: {
					calculate: false,
					cellGap: 1,
					color: { mode: "scheme", scheme: "Oranges", fill: ORANGE, exponent: 0.5, steps: 64 },
					yAxis: { axisPlacement: "left", unit: "s" },
					rowsFrame: { layout: "auto" },
					tooltip: { mode: "single", yHistogram: false, showColorScale: false },
					legend: { show: true },
					cellValues: { decimals: 0 },
				},
			},
		},
		series({
			title: "Skipped and rewound heads",
			description:
				"Measured · blocks the new-head subscription skipped, and notifications at or below " +
				"the previous height. Skips are about delivery to us; rewinds can also come from short " +
				"forks.",
			w: 12,
			h: 7,
			queries: [
				{
					expr: `increase(${sel("flopwatch_ws_head_skipped_blocks_total")}[$__interval])`,
					legend: "skipped blocks",
				},
				{
					expr: `increase(${sel("flopwatch_ws_head_rewinds_total")}[$__interval])`,
					legend: "rewinds",
				},
			],
			bars: true,
			decimals: 0,
		}),
	],
];

const p95 = (target: string) => ({
	expr: `histogram_quantile(0.95, sum by (le, target) (rate(${sel(
		"flopwatch_probe_duration_seconds_bucket",
		target,
	)}[5m])))`,
	legend: "{{target}} p95",
});

const faucet: Spec[][] = [
	[
		timeline({
			title: "Claims ready",
			description: CLAIMS_READY,
			w: 12,
			h: 5,
			queries: [{ expr: sel("flopwatch:faucet_claim_ready"), legend: "claims" }],
			mappings: READY,
		}),
		timeline({
			title: "Faucet probes",
			description:
				"Measured · GET `/limits`, `/health` and `/chain` every 60 s. `/health` counts as up on " +
				"its 503 'degraded' answer too, because that is a valid answer; `/chain` counts as up " +
				"only with a valid genesis hash.",
			w: 12,
			h: 5,
			queries: [
				{ expr: sel("flopwatch_probe_success", 'target=~"faucet_.*"'), legend: "{{target}}" },
			],
			mappings: UP_DOWN,
		}),
	],
	[
		timeline({
			title: "Status",
			description: "Reported · `faucet.status` and `stale` from `/limits`.",
			w: 12,
			h: 5,
			queries: [
				{ expr: FAUCET_STATUS_CODE, legend: "status" },
				{ expr: sel("flopwatch_faucet_stale"), legend: "stale" },
			],
			mappings: [],
			overrides: [
				byName("status", { mappings: FAUCET_STATUS }),
				byName("stale", { mappings: [values([0, "fresh", GREEN], [1, "stale", RED])] }),
			],
		}),
		timeline({
			title: "Sponsor lanes",
			description:
				"Reported · `sponsor.miner.status` and `sponsor.validator.status` from `/limits`. The " +
				"official page shows 'Unavailable' for both when its own check fails.",
			w: 12,
			h: 5,
			queries: [{ expr: SPONSOR_CODE, legend: "{{lane}}" }],
			mappings: SPONSOR_STATUS,
		}),
	],
	[
		series({
			title: "Balance",
			description: "Reported · the faucet's balance and its minimum balance, from `/limits`.",
			w: 8,
			h: 6,
			queries: [
				{ expr: sel("flopwatch_faucet_balance_flop"), legend: "balance" },
				{ expr: sel("flopwatch_faucet_min_balance_flop"), legend: "minimum" },
			],
			unit: "short",
			axisLabel: "FLOP",
			decimals: 0,
			overrides: [byName("minimum", dashed)],
		}),
		series({
			title: "Daily cap",
			description: "Reported · the faucet's daily cap: used, limit and remaining, from `/limits`.",
			w: 8,
			h: 6,
			queries: [
				{ expr: sel("flopwatch_faucet_daily_cap_used_flop"), legend: "used" },
				{ expr: sel("flopwatch_faucet_daily_cap_limit_flop"), legend: "limit" },
				{ expr: sel("flopwatch_faucet_daily_cap_remaining_flop"), legend: "remaining" },
			],
			unit: "short",
			axisLabel: "FLOP",
			decimals: 0,
			overrides: [byName("limit", dashed)],
		}),
		series({
			title: "Pending grants",
			description:
				"Reported · `faucet.pendingGrants` from `/limits`. A rising count means grants are " +
				"queued and not yet paid out.",
			w: 8,
			h: 6,
			queries: [{ expr: sel("flopwatch_faucet_pending_grants"), legend: "pending" }],
			decimals: 0,
		}),
	],
	[
		timeline({
			title: "/health",
			description:
				"Measured (HTTP status) and reported (ready) · GET `/health`. The faucet scopes `ready` " +
				"to the client asking, here flop-watch's own address, so it is not global claim " +
				"readiness; see Claims ready.",
			w: 12,
			h: 5,
			queries: [
				{ expr: sel("flopwatch_faucet_health_http_status_code"), legend: "HTTP status" },
				{ expr: sel("flopwatch_faucet_health_ready"), legend: "ready (this client)" },
			],
			mappings: [],
			overrides: [
				byName("HTTP status", { mappings: HTTP_STATUS }),
				byName("ready (this client)", {
					mappings: [values([1, "ready", BLUE], [0, "not ready", GREY])],
				}),
			],
		}),
		timeline({
			title: "Dependencies",
			description:
				"Reported · `dependencies.<name>.ok` from `/health`. A dependency without an `ok` " +
				"field, such as `signing`, has no row.",
			w: 12,
			h: 5,
			queries: [{ expr: sel("flopwatch_faucet_dependency_ok"), legend: "{{dependency}}" }],
			mappings: [values([1, "ok", GREEN], [0, "not ok", RED])],
		}),
	],
	[
		series({
			title: "Indexer lag (faucet)",
			description:
				"Reported · `dependencies.indexer.details.lagBlocks` from `/health`: how far the " +
				"faucet's indexer is behind its chain head.",
			w: 8,
			h: 6,
			queries: [{ expr: sel("flopwatch_faucet_indexer_lag_blocks"), legend: "lag" }],
			unit: BLOCKS,
			decimals: 0,
		}),
		series({
			title: "/limits data age",
			description:
				"Derived · time since the `asOf` of the last `/limits` answer. It swings between about " +
				"0.4 and 5.4 min in normal operation; the alert fires only when it stays over 5 min " +
				"for 5 min.",
			w: 8,
			h: 6,
			queries: [{ expr: sel("flopwatch:faucet_limits_age_seconds"), legend: "age" }],
			unit: "s",
			thresholds: steps(NONE, [300, ORANGE]),
		}),
		series({
			title: "Response time",
			description: "Measured · p95 response time of the faucet probes from one vantage point.",
			w: 8,
			h: 6,
			queries: [p95('target=~"faucet_.*"')],
			unit: "s",
		}),
	],
];

const explorer: Spec[][] = [
	[
		timeline({
			title: "Explorer probe",
			description:
				"Measured · GET `/api/stats` every 60 s, best effort, because the API is undocumented.",
			w: 8,
			h: 6,
			queries: [
				{ expr: sel("flopwatch_probe_success", 'target="explorer_stats"'), legend: "explorer" },
			],
			mappings: UP_DOWN,
		}),
		series({
			title: "Indexer lag (explorer)",
			description:
				"Derived · our best block minus the explorer's latest indexed block. It can be slightly " +
				"negative, because the two sources are read at different moments and may come from " +
				"different nodes.",
			w: 8,
			h: 6,
			queries: [{ expr: sel("flopwatch:explorer_indexer_lag_blocks"), legend: "lag" }],
			unit: BLOCKS,
			decimals: 0,
			thresholds: steps(NONE, [0, GREY], [120, ORANGE]),
		}),
		series({
			title: "Finality view (explorer)",
			description:
				"Reported · the explorer's own finality lag and `safeMode` flag from `/api/stats`. The " +
				"explorer reports its own thresholds as 30 (warn) and 120 (freeze) blocks.",
			w: 8,
			h: 6,
			queries: [
				{ expr: sel("flopwatch_explorer_finalized_lag_blocks"), legend: "finalized lag" },
				{ expr: sel("flopwatch_explorer_safe_mode"), legend: "safe mode" },
			],
			unit: BLOCKS,
			decimals: 0,
			overrides: [byName("safe mode", { ...flagBars, unit: "none" })],
		}),
	],
];

const identity: Spec[][] = [
	[
		table({
			title: "Chain identity",
			description:
				"Reported · `system_chain`, `state_getRuntimeVersion` and `chain_getBlockHash [0]` " +
				"over the WebSocket, read on every connect.",
			w: 12,
			h: 5,
			queries: [{ expr: sel("flopwatch_chain_info"), instant: true, format: "table" }],
			columns: ["chain", "spec_name", "genesis_hash"],
		}),
		timeline({
			title: "Genesis match",
			description:
				"Reported · whether each source's genesis hash equals the pinned one: the RPC " +
				"WebSocket, RPC HTTP (every 10 min) and the faucet's `/chain` (every 60 s).",
			w: 12,
			h: 5,
			queries: [{ expr: sel("flopwatch_genesis_match"), legend: "{{source}}" }],
			mappings: [values([1, "match", GREEN], [0, "mismatch", RED])],
		}),
	],
	[
		series({
			title: "Runtime version",
			description:
				"Reported · the runtime `specVersion` from the runtime-version subscription. Each step " +
				"is a runtime upgrade, also marked as an annotation.",
			w: 12,
			h: 5,
			queries: [{ expr: sel("flopwatch_runtime_spec_version"), legend: "spec version" }],
			decimals: 0,
			stepped: true,
		}),
		stat({
			title: "Slot duration",
			description: "Reported · BABE slot duration from `BabeApi_configuration`.",
			w: 12,
			h: 5,
			queries: [{ expr: sel("flopwatch_chain_slot_duration_seconds"), instant: true }],
			unit: "s",
		}),
	],
];

const collector: Spec[][] = [
	[
		stat({
			title: "Version",
			description: "Self · the running flop-watch version.",
			w: 6,
			h: 4,
			queries: [{ expr: "flopwatch_build_info", instant: true }],
			textMode: "name",
			colorMode: "none",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a Grafana field template, not JS.
			displayName: "${__field.labels.version}",
		}),
		series({
			title: "Requests to FLOP",
			description:
				"Self · flop-watch's steady-state requests to this network's endpoints, against the " +
				"0.25 requests/s budget: every probe request, including the WebSocket health pings. " +
				"Reconnect identity calls and subscriptions are not counted.",
			w: 9,
			h: 6,
			queries: [{ expr: `sum(rate(${sel("flopwatch_probe_total")}[10m]))`, legend: "requests" }],
			unit: "reqps",
			thresholds: steps(NONE, [0.25, RED]),
		}),
		series({
			title: "Memory",
			description: "Self · the collector's resident memory. The MVP target is under 150 MB.",
			w: 9,
			h: 6,
			queries: [{ expr: 'process_resident_memory_bytes{job="flop-watch"}', legend: "resident" }],
			unit: "decbytes",
			thresholds: steps(NONE, [150_000_000, ORANGE]),
		}),
	],
	[
		table({
			title: "Schema mismatches",
			description:
				"Self · remote fields that were missing or had an unexpected type in the selected " +
				"time range. A FLOP service probably changed its JSON.",
			w: 24,
			h: 6,
			queries: [
				{
					expr: `sum by (target, field) (increase(${sel("flopwatch_schema_mismatch_total")}[$__range])) > 0`,
					instant: true,
					format: "table",
				},
			],
			columns: ["target", "field", "Value"],
			rename: { Value: "count" },
			decimals: 0,
		}),
	],
];

interface Row {
	readonly title: string;
	readonly collapsed?: boolean;
	readonly lines: Spec[][];
}
const ROWS: Row[] = [
	{ title: "Now", lines: [now.slice(0, 4), now.slice(4)] },
	{ title: "Incidents", lines: incidents },
	{ title: "RPC", lines: rpc },
	{ title: "Blocks and finality", lines: blocks },
	{ title: "Faucet", lines: faucet },
	{ title: "Explorer", lines: explorer },
	{ title: "Identity", collapsed: true, lines: identity },
	{ title: "Collector", collapsed: true, lines: collector },
];

/** Places the panels on Grafana's 24-column grid, row by row, and numbers them. */
function layout(): Json[] {
	let id = 0;
	let y = 0;
	const place = (spec: Spec, x: number, top: number): Obj => ({
		id: ++id,
		gridPos: { h: spec.h, w: spec.w, x, y: top },
		...spec.body,
	});
	const panels: Json[] = [place(about, 0, y)];
	y += about.h;
	for (const row of ROWS) {
		const header: Obj = {
			id: ++id,
			type: "row",
			title: row.title,
			gridPos: { h: 1, w: 24, x: 0, y },
		};
		y += 1;
		const children: Json[] = [];
		let top = y;
		for (const line of row.lines) {
			let x = 0;
			for (const spec of line) {
				children.push(place(spec, x, top));
				x += spec.w;
			}
			top += Math.max(...line.map((spec) => spec.h));
		}
		if (row.collapsed === true) {
			panels.push({ ...header, collapsed: true, panels: children });
		} else {
			panels.push({ ...header, collapsed: false, panels: [] }, ...children);
			y = top;
		}
	}
	return panels;
}

export function buildDashboard(): Obj {
	return {
		uid: "flop-watch-overview",
		title: "FLOP Network health — flop-watch",
		description: "Independent, read-only observability for FLOP Network Devnet and Testnet.",
		tags: ["flop", "flop-watch"],
		timezone: "utc",
		editable: false,
		graphTooltip: 1,
		refresh: "1m",
		schemaVersion: 41,
		time: { from: "now-24h", to: "now" },
		timepicker: { refresh_intervals: ["30s", "1m", "5m", "15m", "1h"] },
		links: [{ title: "flop-watch on GitHub", type: "link", url: REPO, targetBlank: true }],
		templating: {
			list: [
				{
					type: "query",
					name: "network",
					label: "Network",
					datasource: DS,
					definition: "label_values(flopwatch_probe_total, network)",
					query: {
						qryType: 1,
						query: "label_values(flopwatch_probe_total, network)",
						refId: "PrometheusVariableQueryEditor-VariableQuery",
					},
					refresh: 1,
					sort: 1,
					multi: false,
					includeAll: false,
					current: { selected: true, text: "testnet", value: "testnet" },
					options: [],
					hide: 0,
				},
			],
		},
		annotations: {
			list: [
				{
					name: "Runtime upgrade",
					datasource: DS,
					enable: true,
					iconColor: BLUE,
					expr: 'ALERTS{alertname="FlopRuntimeUpgraded", alertstate="firing", network="$network"}',
					step: "60s",
					titleFormat: "Runtime upgrade",
					textFormat: "The runtime spec version changed.",
				},
			],
		},
		panels: layout(),
	};
}

if (import.meta.main) {
	const file = new URL("dashboards/flop-watch-overview.json", import.meta.url);
	writeFileSync(file, `${JSON.stringify(buildDashboard(), null, "\t")}\n`);
}
