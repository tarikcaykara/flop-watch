// Stack e2e (`pnpm test:e2e`, needs Docker): builds the collector image and runs the Compose stack
// with test/e2e/compose.e2e.yaml, which keeps the collector away from every FLOP host.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../../", import.meta.url).pathname;
const PROJECT = "flop-watch-e2e";
const E2E_FILES = ["compose.yaml", "test/e2e/compose.e2e.yaml"];

/** Runs `docker compose` in the repository root and returns its stdout. */
async function compose(
	args: readonly string[],
	options: { files?: readonly string[]; envFile?: string; env?: Record<string, string> } = {},
): Promise<string> {
	const files = (options.files ?? E2E_FILES).flatMap((file) => ["-f", file]);
	const envFile = options.envFile ?? "test/e2e/e2e.env";
	const { stdout } = await run(
		"docker",
		["compose", "-p", PROJECT, ...files, "--env-file", envFile, ...args],
		{ cwd: root, env: { ...process.env, ...options.env }, maxBuffer: 16 * 1024 * 1024 },
	);
	return stdout;
}

/** Polls `check` every 2 s until it passes or `timeoutMs` runs out. */
async function poll(check: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await sleep(2_000);
	}
	throw new Error(`never happened: ${what}`);
}

async function freePort(): Promise<number> {
	const server = createServer().listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	server.close();
	await once(server, "close");
	return address.port;
}

interface ComposeService {
	readonly image?: string;
	readonly build?: unknown;
	readonly command?: readonly string[];
	readonly read_only?: boolean;
	readonly ports?: ReadonlyArray<{ host_ip?: string; published?: string; target: number }>;
	readonly environment?: Record<string, string | null>;
	readonly volumes?: ReadonlyArray<{ source?: string; target: string; read_only?: boolean }>;
}
interface ComposeConfig {
	readonly services: Record<string, ComposeService>;
}

describe("compose.yaml", () => {
	let services: Record<string, ComposeService> = {};

	before(async () => {
		const json = await compose(["config", "--format", "json"], {
			files: ["compose.yaml"],
			envFile: ".env.example",
			// An exported GRAFANA_PORT would win over the env file; empty keeps compose's default.
			env: { GRAFANA_PORT: "" },
		});
		const config: ComposeConfig = JSON.parse(json);
		services = config.services;
	});

	it("has the collector, Prometheus and Grafana", () => {
		assert.deepEqual(Object.keys(services).toSorted(), ["flop-watch", "grafana", "prometheus"]);
	});

	it("builds the collector and pins every other image to an exact version", () => {
		assert.ok(services["flop-watch"]?.build, "the collector is built from the repository");
		for (const name of ["prometheus", "grafana"]) {
			assert.match(services[name]?.image ?? "", /:v?\d+\.\d+\.\d+$/, name);
		}
	});

	it("publishes only Grafana, on 127.0.0.1:3000", () => {
		for (const [name, service] of Object.entries(services)) {
			if (name !== "grafana") assert.equal(service.ports, undefined, `${name} is not published`);
		}
		assert.deepEqual(
			services["grafana"]?.ports?.map((p) => ({ ip: p.host_ip, from: p.published, to: p.target })),
			[{ ip: "127.0.0.1", from: "3000", to: 3000 }],
		);
	});

	it("keeps 180 days in Prometheus and bounds its queries", () => {
		const command = services["prometheus"]?.command ?? [];
		for (const flag of [
			"--storage.tsdb.retention.time=180d",
			"--query.timeout=20s",
			"--query.max-samples=5000000",
		]) {
			assert.ok(command.includes(flag), flag);
		}
	});

	it("runs the collector on a read-only root filesystem", () => {
		assert.equal(services["flop-watch"]?.read_only, true);
	});

	it("gives anonymous visitors Viewer access with the §11 hardening", () => {
		const env = services["grafana"]?.environment ?? {};
		for (const [key, value] of Object.entries({
			GF_AUTH_ANONYMOUS_ENABLED: "true",
			GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",
			GF_USERS_ALLOW_SIGN_UP: "false",
			GF_USERS_VIEWERS_CAN_EDIT: "false",
			GF_SNAPSHOTS_EXTERNAL_ENABLED: "false",
			GF_ANALYTICS_REPORTING_ENABLED: "false",
			GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
			GF_METRICS_ENABLED: "false",
			GF_DASHBOARDS_MIN_REFRESH_INTERVAL: "30s",
		})) {
			assert.equal(env[key], value, key);
		}
	});

	it("provisions Grafana from the repository, read-only", () => {
		const mounts = (services["grafana"]?.volumes ?? []).filter((v) => v.read_only);
		assert.deepEqual(mounts.map((v) => v.target).toSorted(), [
			"/etc/grafana/dashboards",
			"/etc/grafana/provisioning/dashboards",
			"/etc/grafana/provisioning/datasources",
		]);
	});
});

describe("the stack", { timeout: 600_000 }, () => {
	let grafanaPort = 0;

	before(async () => {
		grafanaPort = await freePort();
		await compose(["up", "-d", "--build", "--wait", "--wait-timeout", "240"], {
			env: { GRAFANA_PORT: String(grafanaPort) },
		});
	});
	after(async () => {
		await compose(["down", "--volumes", "--remove-orphans"]);
	});

	it("runs a healthy collector as a non-root user", async () => {
		const uid = (await compose(["exec", "-T", "flop-watch", "id", "-u"])).trim();
		assert.notEqual(uid, "0");
		const ps = (await compose(["ps", "--format", "json", "flop-watch"])).trim();
		const container: { Health?: string } = JSON.parse(ps.split("\n")[0] ?? "{}");
		assert.equal(container.Health, "healthy");
	});

	it("has Prometheus scrape the collector", async () => {
		await poll(
			async () => {
				const json = await compose([
					"exec",
					"-T",
					"prometheus",
					"wget",
					"-qO-",
					"http://localhost:9090/api/v1/targets",
				]);
				const targets: {
					data: { activeTargets: Array<{ labels: Record<string, string>; health: string }> };
				} = JSON.parse(json);
				return targets.data.activeTargets.some(
					(t) => t.labels["job"] === "flop-watch" && t.health === "up",
				);
			},
			"the flop-watch target is up",
			90_000,
		);
	});

	it("has Prometheus load the flop-watch rules and evaluate them without errors", async () => {
		let rules: Array<{ name: string; health: string }> = [];
		await poll(
			async () => {
				const json = await compose([
					"exec",
					"-T",
					"prometheus",
					"wget",
					"-qO-",
					"http://localhost:9090/api/v1/rules",
				]);
				const response: {
					data: { groups: Array<{ name: string; rules: Array<{ name: string; health: string }> }> };
				} = JSON.parse(json);
				rules = response.data.groups.find((g) => g.name === "flop-watch")?.rules ?? [];
				return rules.length > 0 && rules.every((r) => r.health === "ok");
			},
			"the flop-watch rules are evaluated",
			60_000,
		);
		// Architecture §7: 6 recording rules and 14 alerts.
		assert.equal(rules.length, 20);
	});

	it("serves Grafana on 127.0.0.1, and publishes nothing else", async () => {
		const health = await fetch(`http://127.0.0.1:${grafanaPort}/api/health`);
		assert.equal(health.status, 200);

		const published = (await compose(["ps", "--format", "json"]))
			.trim()
			.split("\n")
			.flatMap((line) => {
				const container: {
					Service: string;
					Publishers?: Array<{ URL: string; PublishedPort: number; TargetPort: number }>;
				} = JSON.parse(line);
				return (container.Publishers ?? [])
					.filter((p) => p.PublishedPort > 0)
					.map((p) => `${container.Service} ${p.URL}:${p.PublishedPort}->${p.TargetPort}`);
			});
		assert.deepEqual(published, [`grafana 127.0.0.1:${grafanaPort}->3000`]);
	});

	/** Grafana's HTTP API as an anonymous visitor: no credentials at all. */
	const grafana = (path: string, init?: RequestInit) =>
		fetch(`http://127.0.0.1:${grafanaPort}${path}`, init);

	interface Target {
		readonly expr: string;
		readonly instant?: boolean;
		readonly format?: string;
	}
	interface Panel {
		readonly title: string;
		readonly targets?: readonly Target[];
		readonly panels?: readonly Panel[];
	}

	it("serves the dashboard to anonymous visitors, read-only, as the home page", async () => {
		const response = await grafana("/api/dashboards/uid/flop-watch-overview");
		assert.equal(response.status, 200);
		const body: {
			dashboard: { title: string };
			meta: { canSave: boolean; canEdit: boolean };
		} = JSON.parse(await response.text());
		assert.equal(body.dashboard.title, "FLOP Network health — flop-watch");
		assert.equal(body.meta.canSave, false);
		assert.equal(body.meta.canEdit, false);

		const save = await grafana("/api/dashboards/db", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dashboard: { ...body.dashboard, title: "changed" }, overwrite: true }),
		});
		assert.ok([401, 403].includes(save.status), `saving answered ${save.status}`);

		// Grafana 13 answers the home page with a redirect to the dashboard it loaded from
		// default_home_dashboard_path; the slug comes from that dashboard's title.
		const home: { redirectUri?: string } = JSON.parse(
			await (await grafana("/api/dashboards/home")).text(),
		);
		assert.match(home.redirectUri ?? "", /^\/d\/[^/]+\/flop-network-health-/);
	});

	it("runs every panel query without errors, as an anonymous visitor", async () => {
		const { dashboard }: { dashboard: { panels: readonly Panel[] } } = JSON.parse(
			await (await grafana("/api/dashboards/uid/flop-watch-overview")).text(),
		);
		const panels = dashboard.panels.flatMap((p) => [p, ...(p.panels ?? [])]);
		const targets = panels.flatMap((p) => (p.targets ?? []).map((t) => ({ panel: p.title, ...t })));
		assert.ok(targets.length > 40, `${targets.length} queries`);
		for (const target of targets) {
			const response = await grafana("/api/ds/query", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					from: "now-1h",
					to: "now",
					queries: [
						{
							refId: "A",
							datasource: { type: "prometheus", uid: "prometheus" },
							expr: target.expr.replaceAll("$network", "testnet"),
							instant: target.instant === true,
							range: target.instant !== true,
							format: target.format ?? "time_series",
							intervalMs: 60_000,
							maxDataPoints: 500,
						},
					],
				}),
			});
			const result: { results?: { A?: { error?: string } } } = JSON.parse(await response.text());
			assert.equal(response.status, 200, `${target.panel}: ${target.expr}`);
			assert.equal(result.results?.A?.error, undefined, `${target.panel}: ${target.expr}`);
		}
	});

	it("enforces a 30 s minimum refresh", async () => {
		const settings: { minRefreshInterval?: string } = JSON.parse(
			await (await grafana("/api/frontend/settings")).text(),
		);
		assert.equal(settings.minRefreshInterval, "30s");
	});

	it("keeps the §11 hardening at runtime: nothing to sign up, edit, write or scrape", async () => {
		const settings: {
			buildInfo?: { version?: string };
			disableUserSignUp?: boolean;
			viewersCanEdit?: boolean;
			newsFeedEnabled?: boolean;
		} = JSON.parse(await (await grafana("/api/frontend/settings")).text());
		assert.equal(settings.buildInfo?.version, "", "version hidden from anonymous visitors");
		assert.equal(settings.disableUserSignUp, true);
		assert.equal(settings.viewersCanEdit, false);
		assert.equal(settings.newsFeedEnabled, false);

		const post = (path: string, body: unknown) =>
			grafana(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		for (const [path, body] of [
			["/api/snapshots", { dashboard: { title: "x" } }],
			["/api/playlists", { name: "x", interval: "5m", items: [] }],
			["/api/annotations", { text: "x" }],
			["/api/folders", { title: "x" }],
			["/api/library-elements", { name: "x", kind: 1, model: {} }],
		] as const) {
			const response = await post(path, body);
			assert.ok([401, 403].includes(response.status), `${path} answered ${response.status}`);
		}
		assert.equal((await grafana("/metrics")).status, 404, "Grafana's own metrics are off");
	});
});
