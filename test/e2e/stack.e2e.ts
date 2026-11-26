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
});
