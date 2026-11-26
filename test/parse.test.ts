import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	CHAIN_FIELDS,
	HEALTH_FIELDS,
	LIMITS_FIELDS,
	type Parsed,
	parseExplorerStats,
	parseFaucetChain,
	parseFaucetHealth,
	parseFaucetLimits,
	STATS_FIELDS,
} from "../src/parse.ts";

interface Fixtures {
	networks: Record<string, Record<string, Record<string, unknown>>>;
}

const fixtures: Fixtures = JSON.parse(
	readFileSync(new URL("fixtures/services.json", import.meta.url), "utf8"),
);

function body(network: "devnet" | "testnet", target: string, status: 200 | 503): unknown {
	const value = fixtures.networks[network]?.[target]?.[String(status)];
	assert.ok(value !== undefined, `fixture ${network} ${target} ${status}`);
	return value;
}

const REMOVE = Symbol("remove");

/** A deep copy of `source` with the value at the dotted `path` replaced, or removed. */
function withField(source: unknown, path: string, value: unknown): unknown {
	const copy = structuredClone(source);
	const keys = path.split(".");
	const last = keys.pop();
	let parent: unknown = copy;
	for (const key of keys) {
		assert.ok(typeof parent === "object" && parent !== null, `path ${path}`);
		parent = Reflect.get(parent, key);
	}
	assert.ok(typeof parent === "object" && parent !== null && last !== undefined, `path ${path}`);
	if (value === REMOVE) Reflect.deleteProperty(parent, last);
	else Reflect.set(parent, last, value);
	return copy;
}

describe("recorded fixtures", () => {
	it("devnet /limits", () => {
		assert.deepStrictEqual(parseFaucetLimits(body("devnet", "faucet_limits", 200)), {
			value: {
				asOfSeconds: Date.parse("2026-11-25T19:00:09.361Z") / 1000,
				stale: false,
				status: "open",
				balanceFlop: 30482522,
				minBalanceFlop: 10000000,
				dailyCapLimitFlop: 10000000,
				dailyCapUsedFlop: 3323710,
				dailyCapRemainingFlop: 6676290,
				pendingGrants: 0,
				sponsorStatus: { miner: "positions_full", validator: "open" },
			},
			mismatches: [],
		});
	});

	it("testnet /limits", () => {
		assert.deepStrictEqual(parseFaucetLimits(body("testnet", "faucet_limits", 200)), {
			value: {
				asOfSeconds: Date.parse("2026-11-25T18:59:36.401Z") / 1000,
				stale: false,
				status: "open",
				balanceFlop: 3842877,
				minBalanceFlop: 5000,
				dailyCapLimitFlop: 10000000,
				dailyCapUsedFlop: 7193920,
				dailyCapRemainingFlop: 2806080,
				pendingGrants: 0,
				sponsorStatus: { miner: "open", validator: "automatic_full" },
			},
			mismatches: [],
		});
	});

	it("devnet /health (200)", () => {
		assert.deepStrictEqual(parseFaucetHealth(body("devnet", "faucet_health", 200)), {
			value: {
				ready: false,
				dependencyOk: {
					signer: true,
					indexer: true,
					ip_classification: true,
					funding: false,
					signing: null,
				},
				indexerLagBlocks: 2,
			},
			mismatches: [],
		});
	});

	it("testnet /health (503)", () => {
		assert.deepStrictEqual(parseFaucetHealth(body("testnet", "faucet_health", 503)), {
			value: {
				ready: false,
				dependencyOk: {
					signer: true,
					indexer: false,
					ip_classification: true,
					funding: true,
					signing: null,
				},
				indexerLagBlocks: null,
			},
			mismatches: [],
		});
	});

	it("devnet /chain", () => {
		assert.deepStrictEqual(parseFaucetChain(body("devnet", "faucet_chain", 200)), {
			value: {
				genesisHash: "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631",
			},
			mismatches: [],
		});
	});

	it("testnet /chain (200)", () => {
		assert.deepStrictEqual(parseFaucetChain(body("testnet", "faucet_chain", 200)), {
			value: {
				genesisHash: "0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800",
			},
			mismatches: [],
		});
	});

	it("testnet /chain (503 error body)", () => {
		assert.deepStrictEqual(parseFaucetChain(body("testnet", "faucet_chain", 503)), {
			value: { genesisHash: null },
			mismatches: ["genesisHash"],
		});
	});

	it("devnet /api/stats", () => {
		assert.deepStrictEqual(parseExplorerStats(body("devnet", "explorer_stats", 200)), {
			value: { latestBlockNumber: 4637408, finalizedLagBlocks: 5, safeMode: false },
			mismatches: [],
		});
	});

	it("testnet /api/stats (503 error body)", () => {
		assert.deepStrictEqual(parseExplorerStats(body("testnet", "explorer_stats", 503)), {
			value: { latestBlockNumber: null, finalizedLagBlocks: null, safeMode: null },
			mismatches: [...STATS_FIELDS],
		});
	});
});

interface ParserCase {
	readonly name: string;
	readonly target: string;
	readonly parse: (body: unknown) => Parsed<unknown, string>;
	readonly fields: readonly string[];
}

const PARSERS: readonly ParserCase[] = [
	{
		name: "parseFaucetLimits",
		target: "faucet_limits",
		parse: parseFaucetLimits,
		fields: LIMITS_FIELDS,
	},
	{
		name: "parseFaucetHealth",
		target: "faucet_health",
		parse: parseFaucetHealth,
		fields: HEALTH_FIELDS,
	},
	{
		name: "parseFaucetChain",
		target: "faucet_chain",
		parse: parseFaucetChain,
		fields: CHAIN_FIELDS,
	},
	{
		name: "parseExplorerStats",
		target: "explorer_stats",
		parse: parseExplorerStats,
		fields: STATS_FIELDS,
	},
];

/** Fields whose absence (or null) is normal and counts no mismatch. */
const OPTIONAL = new Set([
	"dependencies.signer.ok",
	"dependencies.indexer.ok",
	"dependencies.ip_classification.ok",
	"dependencies.funding.ok",
	"dependencies.signing.ok",
	"dependencies.indexer.details.lagBlocks",
]);

for (const { name, target, parse, fields } of PARSERS) {
	describe(`${name}: removed or retyped fields`, () => {
		const source = body("devnet", target, 200);
		for (const field of fields) {
			it(`${field} retyped to [] is a mismatch`, () => {
				assert.deepStrictEqual(parse(withField(source, field, [])).mismatches, [field]);
			});

			const expected = OPTIONAL.has(field) ? [] : [field];
			it(`${field} removed gives ${JSON.stringify(expected)}`, () => {
				assert.deepStrictEqual(parse(withField(source, field, REMOVE)).mismatches, expected);
			});
		}
	});
}

describe("parseFaucetHealth: dependencies", () => {
	const source = body("devnet", "faucet_health", 200);
	const noDependencies = {
		ready: false,
		dependencyOk: {
			signer: null,
			indexer: null,
			ip_classification: null,
			funding: null,
			signing: null,
		},
		indexerLagBlocks: null,
	};

	it("removed or retyped: one mismatch, every dependency value absent", () => {
		for (const replacement of [REMOVE, [], "ok", null]) {
			assert.deepStrictEqual(parseFaucetHealth(withField(source, "dependencies", replacement)), {
				value: noDependencies,
				mismatches: ["dependencies"],
			});
		}
	});

	it("signing without ok gives no value and no mismatch", () => {
		assert.equal(parseFaucetHealth(source).value.dependencyOk.signing, null);
		assert.equal(
			parseFaucetHealth(body("testnet", "faucet_health", 503)).value.dependencyOk.signing,
			null,
		);
	});

	it("null anywhere on an optional path is absent, not a mismatch", () => {
		const signer = parseFaucetHealth(withField(source, "dependencies.signer.ok", null));
		assert.equal(signer.value.dependencyOk.signer, null);
		assert.deepStrictEqual(signer.mismatches, []);

		const lag = parseFaucetHealth(
			withField(source, "dependencies.indexer.details.lagBlocks", null),
		);
		assert.equal(lag.value.indexerLagBlocks, null);
		assert.deepStrictEqual(lag.mismatches, []);

		const indexer = parseFaucetHealth(withField(source, "dependencies.indexer", null));
		assert.equal(indexer.value.dependencyOk.indexer, null);
		assert.equal(indexer.value.indexerLagBlocks, null);
		assert.deepStrictEqual(indexer.mismatches, []);
	});

	it("a non-object step below dependencies is a mismatch of each field under it", () => {
		const indexer = parseFaucetHealth(withField(source, "dependencies.indexer", []));
		assert.equal(indexer.value.dependencyOk.indexer, null);
		assert.equal(indexer.value.indexerLagBlocks, null);
		assert.equal(indexer.value.dependencyOk.signer, true);
		assert.deepStrictEqual(indexer.mismatches, [
			"dependencies.indexer.ok",
			"dependencies.indexer.details.lagBlocks",
		]);

		const signer = parseFaucetHealth(withField(source, "dependencies.signer", "x"));
		assert.deepStrictEqual(signer.mismatches, ["dependencies.signer.ok"]);

		const details = parseFaucetHealth(withField(source, "dependencies.indexer.details", "x"));
		assert.equal(details.value.dependencyOk.indexer, true);
		assert.deepStrictEqual(details.mismatches, ["dependencies.indexer.details.lagBlocks"]);
	});

	it("a retyped ok is a mismatch", () => {
		const parsed = parseFaucetHealth(withField(source, "dependencies.signing.ok", "yes"));
		assert.equal(parsed.value.dependencyOk.signing, null);
		assert.deepStrictEqual(parsed.mismatches, ["dependencies.signing.ok"]);
	});
});

describe("parseFaucetLimits: enums", () => {
	const source = body("devnet", "faucet_limits", 200);

	for (const [status, expected] of [
		["unknown", "unknown"],
		["low_balance", "low_balance"],
		["paused", "other"],
		["", "other"],
	]) {
		it(`faucet.status "${status}" maps to ${expected}`, () => {
			const parsed = parseFaucetLimits(withField(source, "faucet.status", status));
			assert.equal(parsed.value.status, expected);
			assert.deepStrictEqual(parsed.mismatches, []);
		});
	}

	it("a null or non-string faucet.status is a mismatch", () => {
		for (const status of [null, 5, true]) {
			const parsed = parseFaucetLimits(withField(source, "faucet.status", status));
			assert.equal(parsed.value.status, null);
			assert.deepStrictEqual(parsed.mismatches, ["faucet.status"]);
		}
	});

	it("faucet and both sponsor lanes unknown, sponsor shape as in research §6", () => {
		let unknown = withField(source, "faucet.status", "unknown");
		for (const lane of ["miner", "validator"]) {
			unknown = withField(unknown, `sponsor.${lane}`, {
				status: "unknown",
				reason: "sponsor_unavailable",
			});
		}
		const parsed = parseFaucetLimits(unknown);
		assert.equal(parsed.value.status, "unknown");
		assert.deepStrictEqual(parsed.value.sponsorStatus, { miner: "unknown", validator: "unknown" });
		assert.deepStrictEqual(parsed.mismatches, []);
	});

	it('an unseen sponsor status ("closed") maps to other', () => {
		const parsed = parseFaucetLimits(withField(source, "sponsor.validator.status", "closed"));
		assert.deepStrictEqual(parsed.value.sponsorStatus, {
			miner: "positions_full",
			validator: "other",
		});
		assert.deepStrictEqual(parsed.mismatches, []);
	});
});

describe("parseFaucetLimits: amounts and time", () => {
	const source = body("devnet", "faucet_limits", 200);

	it("a fractional FLOP string becomes a number", () => {
		const parsed = parseFaucetLimits(withField(source, "faucet.balanceFlop", "12.5"));
		assert.equal(parsed.value.balanceFlop, 12.5);
		assert.deepStrictEqual(parsed.mismatches, []);
	});

	for (const amount of ["1e3", "-5", "", "1.", 5]) {
		it(`balanceFlop ${JSON.stringify(amount)} is a mismatch`, () => {
			const parsed = parseFaucetLimits(withField(source, "faucet.balanceFlop", amount));
			assert.equal(parsed.value.balanceFlop, null);
			assert.deepStrictEqual(parsed.mismatches, ["faucet.balanceFlop"]);
		});
	}

	it("an amount beyond the float range is a mismatch", () => {
		const parsed = parseFaucetLimits(
			withField(source, "faucet.balanceFlop", `1${"0".repeat(400)}`),
		);
		assert.equal(parsed.value.balanceFlop, null);
		assert.deepStrictEqual(parsed.mismatches, ["faucet.balanceFlop"]);
	});

	it("an explicit offset gives the same instant as Z", () => {
		const parsed = parseFaucetLimits(withField(source, "asOf", "2026-11-25T20:00:09.361+01:00"));
		assert.equal(parsed.value.asOfSeconds, Date.parse("2026-11-25T19:00:09.361Z") / 1000);
		assert.deepStrictEqual(parsed.mismatches, []);
	});

	for (const asOf of ["not a date", "12", "2026-11-25", "2026-11-25T19:00:09", 1795633209]) {
		it(`asOf ${JSON.stringify(asOf)} (no zone, or not ISO 8601) is a mismatch`, () => {
			const parsed = parseFaucetLimits(withField(source, "asOf", asOf));
			assert.equal(parsed.value.asOfSeconds, null);
			assert.deepStrictEqual(parsed.mismatches, ["asOf"]);
		});
	}
});

describe("parseExplorerStats: numbers", () => {
	it("a non-finite number is a mismatch", () => {
		const source = body("devnet", "explorer_stats", 200);
		for (const n of [Number.POSITIVE_INFINITY, Number.NaN]) {
			const parsed = parseExplorerStats(withField(source, "latestBlockNumber", n));
			assert.equal(parsed.value.latestBlockNumber, null);
			assert.deepStrictEqual(parsed.mismatches, ["latestBlockNumber"]);
		}
	});
});

describe("parseFaucetChain: genesis hash", () => {
	it("an upper-case or short hash is a mismatch", () => {
		const source = body("devnet", "faucet_chain", 200);
		for (const hash of [`0x${"AB".repeat(32)}`, "0x99c1"]) {
			assert.deepStrictEqual(parseFaucetChain(withField(source, "genesisHash", hash)), {
				value: { genesisHash: null },
				mismatches: ["genesisHash"],
			});
		}
	});
});

describe("non-object bodies", () => {
	for (const raw of [null, "text", 42, [], {}]) {
		it(`${JSON.stringify(raw)} mismatches every required field, without throwing`, () => {
			assert.deepStrictEqual(parseFaucetLimits(raw).mismatches, [...LIMITS_FIELDS]);
			assert.deepStrictEqual(parseFaucetHealth(raw).mismatches, ["ready", "dependencies"]);
			assert.deepStrictEqual(parseFaucetChain(raw).mismatches, [...CHAIN_FIELDS]);
			assert.deepStrictEqual(parseExplorerStats(raw).mismatches, [...STATS_FIELDS]);
		});
	}
});
