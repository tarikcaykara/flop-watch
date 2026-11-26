// Pure, tolerant parsers for the faucet and explorer responses (architecture §5, §6). Each takes
// an already-parsed JSON body and returns only the fields behind §6 metrics, plus the allowlisted
// fields that were missing or retyped, for flopwatch_schema_mismatch_total. Nothing here throws
// on remote data, does I/O or touches a metric.

import {
	FAUCET_STATUSES,
	type FaucetDependency,
	type FaucetStatus,
	SPONSOR_STATUSES,
	type SponsorLane,
	type SponsorStatus,
} from "./metrics.ts";

// The `field` label values: each field's dotted JSON path, exactly as the remote sends it.
// Fields are read in array order, so mismatches come out in that order.

export const LIMITS_FIELDS = [
	"asOf",
	"stale",
	"faucet.status",
	"faucet.balanceFlop",
	"faucet.minBalanceFlop",
	"faucet.dailyCap.limitFlop",
	"faucet.dailyCap.usedFlop",
	"faucet.dailyCap.remainingFlop",
	"faucet.pendingGrants",
	"sponsor.miner.status",
	"sponsor.validator.status",
] as const;
export type LimitsField = (typeof LIMITS_FIELDS)[number];

export const HEALTH_FIELDS = [
	"ready",
	"dependencies",
	"dependencies.signer.ok",
	"dependencies.indexer.ok",
	"dependencies.ip_classification.ok",
	"dependencies.funding.ok",
	"dependencies.signing.ok",
	"dependencies.indexer.details.lagBlocks",
] as const;
export type HealthField = (typeof HEALTH_FIELDS)[number];

export const CHAIN_FIELDS = ["genesisHash"] as const;
export type ChainField = (typeof CHAIN_FIELDS)[number];

export const STATS_FIELDS = [
	"latestBlockNumber",
	"finality.finalizedLag",
	"finality.safeMode",
] as const;
export type StatsField = (typeof STATS_FIELDS)[number];

export interface Parsed<T, F extends string> {
	readonly value: T;
	/** Allowlisted fields that were missing or had an unexpected type, in allowlist order. */
	readonly mismatches: readonly F[];
}

/** Faucet `/limits`. FLOP amounts are whole-token decimal strings on the wire. */
export interface FaucetLimits {
	/** `asOf` as Unix seconds. */
	readonly asOfSeconds: number | null;
	readonly stale: boolean | null;
	readonly status: FaucetStatus | null;
	readonly balanceFlop: number | null;
	readonly minBalanceFlop: number | null;
	readonly dailyCapLimitFlop: number | null;
	readonly dailyCapUsedFlop: number | null;
	readonly dailyCapRemainingFlop: number | null;
	readonly pendingGrants: number | null;
	readonly sponsorStatus: Readonly<Record<SponsorLane, SponsorStatus | null>>;
}

/** Faucet `/health`; its HTTP status code is measured by the probe, not parsed. */
export interface FaucetHealth {
	readonly ready: boolean | null;
	/** null: `ok` missing or null (e.g. `signing`, which has no `ok`), or retyped. */
	readonly dependencyOk: Readonly<Record<FaucetDependency, boolean | null>>;
	readonly indexerLagBlocks: number | null;
}

/** Faucet `/chain`. */
export interface FaucetChain {
	readonly genesisHash: string | null;
}

/** Explorer `/api/stats`. */
export interface ExplorerStats {
	readonly latestBlockNumber: number | null;
	readonly finalizedLagBlocks: number | null;
	readonly safeMode: boolean | null;
}

/** Turns a raw JSON value into a typed one; null means missing or unexpected. */
type Convert<T> = (v: unknown) => T | null;

const GENESIS_RE = /^0x[0-9a-f]{64}$/;
const FLOP_RE = /^\d+(?:\.\d+)?$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Stands for a path through a step that exists but is not an object; every converter rejects it. */
const NOT_OBJECT = Symbol("not an object");

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The value at a dotted path. A missing or null step gives that value (undefined or null); a step
 * that exists but is not an object gives NOT_OBJECT.
 */
function at(body: unknown, path: string): unknown {
	let value = body;
	for (const key of path.split(".")) {
		if (value === undefined || value === null) return value;
		if (!isRecord(value)) return NOT_OBJECT;
		value = value[key];
	}
	return value;
}

const asNumber: Convert<number> = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const asBoolean: Convert<boolean> = (v) => (typeof v === "boolean" ? v : null);

/** A non-negative decimal string ("30482522", "12.5"); JSON numbers and exponents are mismatches. */
const asFlop: Convert<number> = (v) => {
	if (typeof v !== "string" || !FLOP_RE.test(v)) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/**
 * An ISO 8601 date-time with an explicit zone, as `toISOString()` writes it, in Unix seconds. A
 * zone-less string would be read in the host's time zone, so it is a mismatch.
 */
const asTimestamp: Convert<number> = (v) => {
	if (typeof v !== "string" || !ISO_TIME_RE.test(v)) return null;
	const ms = Date.parse(v);
	return Number.isNaN(ms) ? null : ms / 1000;
};

const asGenesis: Convert<string> = (v) => (typeof v === "string" && GENESIS_RE.test(v) ? v : null);

/** Any string is valid: a known value maps to itself, an unseen one to "other". */
function asEnum<T extends string>(values: readonly T[]): Convert<T | "other"> {
	return (v) => (typeof v === "string" ? (values.find((k) => k === v) ?? "other") : null);
}

const asFaucetStatus = asEnum(FAUCET_STATUSES);
const asSponsorStatus = asEnum(SPONSOR_STATUSES);

interface Reader<F extends string> {
	readonly mismatches: F[];
	/** A required field: missing, null or retyped records a mismatch. */
	read<T>(field: F, convert: Convert<T>): T | null;
	/**
	 * An optional field: missing or null, there or anywhere on its path, gives null silently; a
	 * non-object on the path or a retyped value records a mismatch.
	 */
	readOptional<T>(field: F, convert: Convert<T>): T | null;
}

function reader<F extends string>(body: unknown): Reader<F> {
	const mismatches: F[] = [];
	const take = <T>(field: F, raw: unknown, convert: Convert<T>): T | null => {
		const value = convert(raw);
		if (value === null) mismatches.push(field);
		return value;
	};
	return {
		mismatches,
		read: (field, convert) => take(field, at(body, field), convert),
		readOptional: (field, convert) => {
			const raw = at(body, field);
			return raw === undefined || raw === null ? null : take(field, raw, convert);
		},
	};
}

export function parseFaucetLimits(body: unknown): Parsed<FaucetLimits, LimitsField> {
	const { mismatches, read } = reader<LimitsField>(body);
	const value: FaucetLimits = {
		asOfSeconds: read("asOf", asTimestamp),
		stale: read("stale", asBoolean),
		status: read("faucet.status", asFaucetStatus),
		balanceFlop: read("faucet.balanceFlop", asFlop),
		minBalanceFlop: read("faucet.minBalanceFlop", asFlop),
		dailyCapLimitFlop: read("faucet.dailyCap.limitFlop", asFlop),
		dailyCapUsedFlop: read("faucet.dailyCap.usedFlop", asFlop),
		dailyCapRemainingFlop: read("faucet.dailyCap.remainingFlop", asFlop),
		pendingGrants: read("faucet.pendingGrants", asNumber),
		sponsorStatus: {
			miner: read("sponsor.miner.status", asSponsorStatus),
			validator: read("sponsor.validator.status", asSponsorStatus),
		},
	};
	return { value, mismatches };
}

export function parseFaucetHealth(body: unknown): Parsed<FaucetHealth, HealthField> {
	const { mismatches, read, readOptional } = reader<HealthField>(body);
	const ready = read("ready", asBoolean);
	// A missing or non-object `dependencies` is one mismatch; the fields below it are then not read.
	const hasDependencies = read("dependencies", (v) => (isRecord(v) ? true : null)) !== null;
	const readDependency = <T>(field: HealthField, convert: Convert<T>): T | null =>
		hasDependencies ? readOptional(field, convert) : null;
	const value: FaucetHealth = {
		ready,
		dependencyOk: {
			signer: readDependency("dependencies.signer.ok", asBoolean),
			indexer: readDependency("dependencies.indexer.ok", asBoolean),
			ip_classification: readDependency("dependencies.ip_classification.ok", asBoolean),
			funding: readDependency("dependencies.funding.ok", asBoolean),
			signing: readDependency("dependencies.signing.ok", asBoolean),
		},
		indexerLagBlocks: readDependency("dependencies.indexer.details.lagBlocks", asNumber),
	};
	return { value, mismatches };
}

export function parseFaucetChain(body: unknown): Parsed<FaucetChain, ChainField> {
	const { mismatches, read } = reader<ChainField>(body);
	return { value: { genesisHash: read("genesisHash", asGenesis) }, mismatches };
}

export function parseExplorerStats(body: unknown): Parsed<ExplorerStats, StatsField> {
	const { mismatches, read } = reader<StatsField>(body);
	const value: ExplorerStats = {
		latestBlockNumber: read("latestBlockNumber", asNumber),
		finalizedLagBlocks: read("finality.finalizedLag", asNumber),
		safeMode: read("finality.safeMode", asBoolean),
	};
	return { value, mismatches };
}
