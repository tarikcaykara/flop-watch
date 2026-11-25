// HTTP JSON-RPC probe: latency, identity, BABE configuration and node health per network.
// Usage: node poc/rpc-http.mts [--networks=devnet,testnet] [--samples=10] > rpc-http.json

import {
	argValue,
	at,
	countBy,
	decodeBabeConfiguration,
	distinct,
	log,
	NETWORKS,
	type NetworkName,
	type RpcHttpResult,
	rpcHttp,
	selectedNetworks,
	sleep,
	summarize,
} from "./common.mts";

const SAMPLES = Number(argValue("samples") ?? 10);
const SAMPLE_GAP_MS = 3_000;

async function probeNetwork(name: NetworkName) {
	const net = NETWORKS[name];
	const calls: Array<{ method: string; res: RpcHttpResult }> = [];
	const call = async (method: string, params: unknown[] = []) => {
		const res = await rpcHttp(net.rpcHttp, method, params);
		calls.push({ method, res });
		if (res.error) log(name, method, res.error.kind, res.error.message);
		return res;
	};

	const genesis = await call("chain_getBlockHash", [0]);
	const runtime = await call("state_getRuntimeVersion");
	const chain = await call("system_chain");
	const babeCfg = await call("state_call", ["BabeApi_configuration", "0x"]);
	const babe = typeof babeCfg.result === "string" ? decodeBabeConfiguration(babeCfg.result) : null;

	const bestNumbers: number[] = [];
	const peers: number[] = [];
	const isSyncing: unknown[] = [];
	const startedAt = Date.now();
	for (let i = 0; i < SAMPLES; i++) {
		if (i > 0) await sleep(SAMPLE_GAP_MS);
		const header = await call("chain_getHeader");
		const health = await call("system_health");
		await call("chain_getFinalizedHead");
		const number = at(header.result, "number");
		if (typeof number === "string") bestNumbers.push(Number.parseInt(number, 16));
		const p = at(health.result, "peers");
		if (typeof p === "number") peers.push(p);
		isSyncing.push(at(health.result, "isSyncing"));
		log(name, `sample ${i + 1}/${SAMPLES}`, bestNumbers.at(-1));
	}
	const elapsedSec = (Date.now() - startedAt) / 1000;

	const latencyMs: Record<string, ReturnType<typeof summarize>> = {};
	for (const method of distinct(calls.map((c) => c.method))) {
		latencyMs[method] = summarize(calls.filter((c) => c.method === method && !c.res.error).map((c) => c.res.ms));
	}
	const rateLimitHeaders: Record<string, string[]> = {};
	for (const { res } of calls) {
		for (const [k, v] of Object.entries(res.headers)) {
			if (k === "server" || k === "cf-cache-status") continue;
			rateLimitHeaders[k] = distinct([...(rateLimitHeaders[k] ?? []), v]);
		}
	}
	const genesisHash = typeof genesis.result === "string" ? genesis.result : null;
	const firstBest = bestNumbers[0] ?? null;
	const lastBest = bestNumbers.at(-1) ?? null;

	return {
		rpcHttp: net.rpcHttp,
		requests: calls.length,
		latencyMs,
		httpStatusCounts: countBy(calls.map((c) => c.res.httpStatus)),
		errorCounts: countBy(calls.filter((c) => c.res.error).map((c) => `${c.method}: ${c.res.error?.kind} ${c.res.error?.code ?? ""} ${c.res.error?.message}`)),
		serverHeaders: distinct(calls.map((c) => c.res.headers.server).filter(Boolean)),
		cfCacheStatus: distinct(calls.map((c) => c.res.headers["cf-cache-status"]).filter(Boolean)),
		rateLimitHeaders,
		genesisHash,
		expectedGenesis: net.expectedGenesis,
		genesisMatch: genesisHash === net.expectedGenesis,
		chain: chain.result ?? null,
		specName: at(runtime.result, "specName") ?? null,
		implName: at(runtime.result, "implName") ?? null,
		specVersion: at(runtime.result, "specVersion") ?? null,
		transactionVersion: at(runtime.result, "transactionVersion") ?? null,
		slotDurationMs: babe?.slotDurationMs ?? null,
		epochLength: babe?.epochLength ?? null,
		health: {
			peers: peers.length ? { min: Math.min(...peers), max: Math.max(...peers) } : null,
			isSyncing: distinct(isSyncing),
		},
		bestNumbers: { first: firstBest, last: lastBest },
		bestAdvancePerSec:
			firstBest !== null && lastBest !== null ? Math.round(((lastBest - firstBest) / elapsedSec) * 1000) / 1000 : null,
		elapsedSec,
	};
}

const networks = selectedNetworks();
const startedAt = new Date().toISOString();
const results = await Promise.all(networks.map(async (n) => [n, await probeNetwork(n)] as const));
console.log(
	JSON.stringify(
		{ script: "rpc-http", startedAt, finishedAt: new Date().toISOString(), node: process.version, networks: Object.fromEntries(results) },
		null,
		2,
	),
);
