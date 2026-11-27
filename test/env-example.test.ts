import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

/** `KEY=VALUE` lines of .env.example, set or commented out as documentation (`# KEY=VALUE`). */
const lines = readFileSync(new URL("../.env.example", import.meta.url), "utf8").split("\n");
const entries = lines.flatMap((line) => {
	const match = /^(# )?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
	if (!match?.[2]) return [];
	return [{ key: match[2], value: match[3] ?? "", commented: match[1] !== undefined }];
});
const collector = entries.filter((e) => e.key.startsWith("FLOPWATCH_"));

describe(".env.example", () => {
	it("lists every collector variable and the stack's own", () => {
		const networkVars = [
			"RPC_WS",
			"RPC_HTTP",
			"FAUCET_URL",
			"EXPLORER_API_URL",
			"EXPECTED_GENESIS",
		];
		const expected = [
			"FLOPWATCH_NETWORKS",
			"FLOPWATCH_HOST",
			"FLOPWATCH_PORT",
			"FLOPWATCH_LOG_LEVEL",
			...["DEVNET", "TESTNET"].flatMap((net) => networkVars.map((v) => `FLOPWATCH_${net}_${v}`)),
			"GRAFANA_ADMIN_PASSWORD",
			"GRAFANA_PORT",
			"GRAFANA_ROOT_URL",
			"COLLECTOR_VERSION",
		];
		assert.deepEqual(entries.map((e) => e.key).toSorted(), expected.toSorted());
	});

	it("documents the collector's defaults", () => {
		const documented = Object.fromEntries(collector.map((e) => [e.key, e.value]));
		assert.deepEqual(loadConfig(documented), loadConfig({}));
	});

	it("leaves every collector variable commented out, so a copied .env keeps the code defaults", () => {
		// A set value would pin, for example, an expected genesis that a profile update changes.
		for (const { key, commented } of collector) assert.ok(commented, key);
	});

	it("sets the Grafana admin password, so `docker compose up` needs no manual step", () => {
		const password = entries.find((e) => e.key === "GRAFANA_ADMIN_PASSWORD");
		assert.ok(password && !password.commented && password.value !== "");
	});
});
