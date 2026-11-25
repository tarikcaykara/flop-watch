// Service probe: faucet /limits, /health, /chain and explorer /stats over ~5 minutes per network.
// Usage: node poc/services.mts [--networks=devnet,testnet] [--samples=10] > services.json
// GET requests only; no faucet claim or write endpoint is ever called.

import {
	argValue,
	at,
	countBy,
	distinct,
	type GetJsonResult,
	getJson,
	log,
	NETWORKS,
	type NetworkName,
	selectedNetworks,
	sleep,
	summarize,
} from "./common.mts";

const SAMPLES = Number(argValue("samples") ?? 10);
const SAMPLE_GAP_MS = 30_000;

type Target = "faucet_limits" | "faucet_health" | "faucet_chain" | "explorer_stats";
const TARGETS: Target[] = ["faucet_limits", "faucet_health", "faucet_chain", "explorer_stats"];

const numbers = (values: unknown[]) => values.filter((v): v is number => typeof v === "number");
const range = (values: unknown[]) => {
	const nums = numbers(values);
	return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null;
};
const isOk = (r: GetJsonResult) => r.httpStatus !== null && r.httpStatus >= 200 && r.httpStatus < 300;

async function probeNetwork(name: NetworkName) {
	const net = NETWORKS[name];
	const urls: Record<Target, string> = {
		faucet_limits: `${net.faucet}/limits`,
		faucet_health: `${net.faucet}/health`,
		faucet_chain: `${net.faucet}/chain`,
		explorer_stats: `${net.explorerApi}/stats`,
	};
	const responses: Record<Target, GetJsonResult[]> = {
		faucet_limits: [],
		faucet_health: [],
		faucet_chain: [],
		explorer_stats: [],
	};
	const firstBodies: Partial<Record<Target, { httpStatus: number | null; body: unknown }>> = {};
	const firstOkBodies: Partial<Record<Target, unknown>> = {};
	const timeline: Array<Record<string, unknown>> = [];

	const get = async (target: Target) => {
		const res = await getJson(urls[target]);
		responses[target].push(res);
		if (!(target in firstBodies)) firstBodies[target] = { httpStatus: res.httpStatus, body: res.body };
		else if (isOk(res) && !isOk(responses[target][0]) && !(target in firstOkBodies)) firstOkBodies[target] = res.body;
		if (res.error) log(name, target, res.httpStatus, res.error);
		return res;
	};

	const chain = await get("faucet_chain");
	for (let i = 0; i < SAMPLES; i++) {
		if (i > 0) await sleep(SAMPLE_GAP_MS);
		const limits = await get("faucet_limits");
		const health = await get("faucet_health");
		const stats = await get("explorer_stats");
		timeline.push({
			at: new Date().toISOString(),
			limitsHttp: limits.httpStatus,
			limitsMs: Math.round(limits.ms),
			faucetStatus: at(limits.body, "faucet", "status") ?? null,
			stale: at(limits.body, "stale") ?? null,
			minerStatus: at(limits.body, "sponsor", "miner", "status") ?? null,
			validatorStatus: at(limits.body, "sponsor", "validator", "status") ?? null,
			healthHttp: health.httpStatus,
			healthStatus: at(health.body, "status") ?? null,
			explorerHttp: stats.httpStatus,
		});
		log(name, `sample ${i + 1}/${SAMPLES}`, JSON.stringify(timeline.at(-1)));
	}

	const targets: Record<string, unknown> = {};
	for (const target of TARGETS) {
		const rs = responses[target];
		targets[target] = {
			url: urls[target],
			requests: rs.length,
			latencyMs: summarize(rs.filter((r) => r.httpStatus !== null).map((r) => r.ms)),
			httpStatusCounts: countBy(rs.map((r) => r.httpStatus)),
			errors: distinct(rs.map((r) => r.error).filter(Boolean)),
			headers: distinct(rs.map((r) => JSON.stringify(r.headers))).map((h) => JSON.parse(h)),
		};
	}

	const limits = responses.faucet_limits.map((r) => r.body).filter((b) => b !== null);
	const asOfAges = limits
		.map((b) => at(b, "asOf"))
		.filter((v): v is string => typeof v === "string")
		.map((v) => (Date.now() - Date.parse(v)) / 1000);
	const sponsorReasons = limits.flatMap((b) =>
		["miner", "validator"].map((lane) => at(b, "sponsor", lane, "reason")).filter((v) => v !== undefined),
	);

	const healthBodies = responses.faucet_health.map((r) => r.body).filter((b) => b !== null);
	const dependencies: Record<string, { ok: unknown[]; reason: unknown[] }> = {};
	for (const body of healthBodies) {
		const deps = at(body, "dependencies");
		if (typeof deps !== "object" || deps === null) continue;
		for (const dep of Object.keys(deps)) {
			const entry = (dependencies[dep] ??= { ok: [], reason: [] });
			entry.ok = distinct([...entry.ok, at(deps, dep, "ok") ?? null]);
			entry.reason = distinct([...entry.reason, at(deps, dep, "reason") ?? null]);
		}
	}

	const stats = responses.explorer_stats;
	const okStats = stats.filter(isOk).map((r) => r.body);
	const chainGenesis = at(chain.body, "genesisHash");

	return {
		targets,
		limits: {
			asOfAgeSec: summarize(asOfAges),
			staleValues: distinct(limits.map((b) => at(b, "stale") ?? null)),
			faucetStatusValues: distinct(limits.map((b) => at(b, "faucet", "status") ?? null)),
			sponsorMinerStatuses: distinct(limits.map((b) => at(b, "sponsor", "miner", "status") ?? null)),
			sponsorValidatorStatuses: distinct(limits.map((b) => at(b, "sponsor", "validator", "status") ?? null)),
			sponsorReasons: distinct(sponsorReasons),
			pendingGrants: range(limits.map((b) => at(b, "faucet", "pendingGrants"))),
			balanceFlop: distinct(limits.map((b) => at(b, "faucet", "balanceFlop") ?? null)),
			dailyCapRemainingFlop: distinct(limits.map((b) => at(b, "faucet", "dailyCap", "remainingFlop") ?? null)),
		},
		health: {
			statusValues: distinct(healthBodies.map((b) => at(b, "status") ?? null)),
			readyValues: distinct(healthBodies.map((b) => at(b, "ready") ?? null)),
			httpCodes: distinct(responses.faucet_health.map((r) => r.httpStatus)),
			dependencies,
			indexerLagBlocks: range(healthBodies.map((b) => at(b, "dependencies", "indexer", "details", "lagBlocks"))),
		},
		faucetChain: {
			network: at(chain.body, "network") ?? null,
			genesisHash: chainGenesis ?? null,
		},
		faucetGenesisMatch: chainGenesis === net.expectedGenesis,
		explorer: {
			finalityStateValues: distinct(okStats.map((b) => at(b, "finality", "state") ?? null)),
			finalizedLag: range(okStats.map((b) => at(b, "finality", "finalizedLag"))),
			latestBlockNumber: range(okStats.map((b) => at(b, "latestBlockNumber"))),
			errorBodies: distinct(stats.filter((r) => !isOk(r)).map((r) => JSON.stringify(r.body ?? r.error ?? null))),
		},
		timeline,
		firstBodies,
		firstOkBodies,
	};
}

const networks = selectedNetworks();
const startedAt = new Date().toISOString();
const results = await Promise.all(networks.map(async (n) => [n, await probeNetwork(n)] as const));
console.log(
	JSON.stringify(
		{ script: "services", startedAt, finishedAt: new Date().toISOString(), node: process.version, networks: Object.fromEntries(results) },
		null,
		2,
	),
);
