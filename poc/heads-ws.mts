// WebSocket head-tracking probe: subscriptions, notification cadence, BABE slot intervals, finality lag.
// Usage: node poc/heads-ws.mts [--seconds=300] [--networks=devnet,testnet] > heads-ws.json
// One connection per network, no reconnect: a close event is a finding.

import {
	argValue,
	at,
	type BabePreDigest,
	babeFromHeader,
	countBy,
	decodeBabeConfiguration,
	headerHash,
	isRpcHeader,
	log,
	NETWORKS,
	type NetworkName,
	type RpcHeader,
	rpcHttp,
	selectedNetworks,
	summarize,
} from "./common.mts";

const CONNECT_TIMEOUT_MS = 10_000;
const seconds = Number(argValue("seconds") ?? 300);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds must be a positive number");

type SubKind = "newHeads" | "finalizedHeads" | "runtimeVersion";
const KINDS: SubKind[] = ["newHeads", "finalizedHeads", "runtimeVersion"];
const SUBSCRIBE: Record<SubKind, string> = {
	newHeads: "chain_subscribeNewHeads",
	finalizedHeads: "chain_subscribeFinalizedHeads",
	runtimeVersion: "state_subscribeRuntimeVersion",
};
const NOTIFICATION_KIND: Record<string, SubKind> = {
	chain_newHead: "newHeads",
	chain_finalizedHead: "finalizedHeads",
	state_runtimeVersion: "runtimeVersion",
};

async function watchNetwork(name: NetworkName) {
	const net = NETWORKS[name];

	const cfg = await rpcHttp(net.rpcHttp, "state_call", ["BabeApi_configuration", "0x"]);
	const slotDurationMs = typeof cfg.result === "string" ? decodeBabeConfiguration(cfg.result).slotDurationMs : null;
	if (slotDurationMs === null) log(name, "BabeApi_configuration failed", cfg.error);

	// Self-check: our header hashing must reproduce the node's block hash, otherwise parent links are meaningless.
	const fin = await rpcHttp(net.rpcHttp, "chain_getFinalizedHead");
	const finHeader = typeof fin.result === "string" ? await rpcHttp(net.rpcHttp, "chain_getHeader", [fin.result]) : null;
	const headerHashSelfCheck = finHeader && isRpcHeader(finHeader.result) ? headerHash(finHeader.result) === fin.result : null;

	const subscriptions: Record<string, { id?: string; ms?: number; error?: string }> = {};
	const closeEvents: Array<{ code: number; reason: string; wasClean: boolean; atSec: number; byUs: boolean }> = [];
	let errorEvents = 0;
	let invalidMessages = 0;
	let connectMs: number | null = null;
	let connectError: string | null = null;

	let headEvents = 0;
	let finalizedEvents = 0;
	const headIntervals: number[] = [];
	const finalizedIntervals: number[] = [];
	let lastHeadAt: number | null = null;
	let lastFinalizedAt: number | null = null;
	let prev: { n: number; hash: string; babe: BabePreDigest | null } | null = null;
	let firstBest: number | null = null;
	let lastBest: number | null = null;
	let skippedBlocks = 0;
	let rewinds = 0;
	let duplicateHeights = 0;
	let parentMismatches = 0;
	const slotIntervals: number[] = [];
	const slotIntervalsOverGaps: number[] = [];
	let maxSkewSec: number | null = null;
	let undecodedHeaders = 0;
	const variants: number[] = [];
	const authorities: number[] = [];

	let firstFinalized: number | null = null;
	let lastFinalized: number | null = null;
	let finalizedSkipped = 0;
	const finalityLag: number[] = [];
	let negativeLagCount = 0;
	const finalizedSlotAgeSec: number[] = [];
	const runtimeVersionEvents: unknown[] = [];

	const onHead = (header: RpcHeader) => {
		const now = performance.now();
		headEvents++;
		if (lastHeadAt !== null) headIntervals.push(now - lastHeadAt);
		lastHeadAt = now;
		const n = Number.parseInt(header.number, 16);
		const hash = headerHash(header);
		const babe = babeFromHeader(header);
		if (!babe) undecodedHeaders++;
		else {
			variants.push(babe.variant);
			authorities.push(babe.authorityIndex);
			if (slotDurationMs !== null) {
				const skew = Math.abs(Number(babe.slot) * slotDurationMs - Date.now()) / 1000;
				maxSkewSec = Math.max(maxSkewSec ?? 0, skew);
			}
		}
		if (prev) {
			if (n > prev.n + 1) {
				skippedBlocks += n - prev.n - 1;
				if (babe && prev.babe && slotDurationMs !== null) {
					slotIntervalsOverGaps.push((Number(babe.slot - prev.babe.slot) * slotDurationMs) / (n - prev.n));
				}
			}
			if (n <= prev.n) {
				rewinds++;
				if (n === prev.n) duplicateHeights++;
			}
			if (n === prev.n + 1) {
				if (header.parentHash !== prev.hash) parentMismatches++;
				else if (babe && prev.babe && slotDurationMs !== null) {
					slotIntervals.push(Number(babe.slot - prev.babe.slot) * slotDurationMs);
				}
			}
		}
		firstBest ??= n;
		lastBest = n;
		prev = { n, hash, babe };
	};

	const onFinalized = (header: RpcHeader) => {
		const now = performance.now();
		finalizedEvents++;
		if (lastFinalizedAt !== null) finalizedIntervals.push(now - lastFinalizedAt);
		lastFinalizedAt = now;
		const n = Number.parseInt(header.number, 16);
		if (lastFinalized !== null && n > lastFinalized + 1) finalizedSkipped += n - lastFinalized - 1;
		firstFinalized ??= n;
		lastFinalized = n;
		if (lastBest !== null) {
			const lag = lastBest - n;
			finalityLag.push(lag);
			if (lag < 0) negativeLagCount++;
		}
		const babe = babeFromHeader(header);
		if (babe && slotDurationMs !== null) finalizedSlotAgeSec.push((Date.now() - Number(babe.slot) * slotDurationMs) / 1000);
	};

	const t0 = performance.now();
	let openedAt: number | null = null;
	await new Promise<void>((resolve) => {
		const ws = new WebSocket(net.rpcWs);
		let byUs = false;
		let done = false;
		const pending = new Map<number, { kind: SubKind; sentAt: number }>();
		const subs = new Map<string, SubKind>();
		let endTimer: ReturnType<typeof setTimeout> | undefined;
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(connectTimer);
			clearTimeout(endTimer);
			clearInterval(progressTimer);
			resolve();
		};
		const connectTimer = setTimeout(() => {
			if (openedAt !== null) return;
			connectError = "connect_timeout";
			byUs = true;
			ws.close();
			finish();
		}, CONNECT_TIMEOUT_MS);

		ws.addEventListener("open", () => {
			openedAt = performance.now();
			connectMs = openedAt - t0;
			log(name, `ws open in ${Math.round(connectMs)} ms`);
			let id = 0;
			for (const kind of KINDS) {
				pending.set(++id, { kind, sentAt: performance.now() });
				ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: SUBSCRIBE[kind], params: [] }));
			}
			endTimer = setTimeout(() => {
				byUs = true;
				ws.close(1000, "probe finished");
				setTimeout(finish, 2_000);
			}, seconds * 1000);
			progressTimer = setInterval(
				() => log(name, `heads=${headEvents} finalized=${finalizedEvents} best=${lastBest} fin=${lastFinalized}`),
				30_000,
			);
		});

		ws.addEventListener("message", (ev: MessageEvent) => {
			let msg: unknown;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				invalidMessages++;
				return;
			}
			const id = at(msg, "id");
			if (typeof id === "number" && pending.has(id)) {
				const req = pending.get(id);
				pending.delete(id);
				if (!req) return;
				const err = at(msg, "error");
				if (err !== undefined && err !== null) {
					subscriptions[req.kind] = { error: `${at(err, "code")} ${at(err, "message")}` };
					log(name, "subscription refused", req.kind, subscriptions[req.kind].error);
				} else {
					const sid = String(at(msg, "result"));
					subs.set(sid, req.kind);
					subscriptions[req.kind] = { id: sid, ms: Math.round((performance.now() - req.sentAt) * 10) / 10 };
				}
				return;
			}
			const method = at(msg, "method");
			const kind = subs.get(String(at(msg, "params", "subscription"))) ?? NOTIFICATION_KIND[String(method)];
			const result = at(msg, "params", "result");
			if (kind === "runtimeVersion") runtimeVersionEvents.push(at(result, "specVersion") ?? null);
			else if (kind && isRpcHeader(result)) (kind === "newHeads" ? onHead : onFinalized)(result);
			else invalidMessages++;
		});

		ws.addEventListener("error", (ev: Event) => {
			errorEvents++;
			const message = at(ev, "message");
			log(name, "ws error", message ?? ev.type);
			if (openedAt === null) connectError = String(message ?? "error");
		});

		ws.addEventListener("close", (ev: CloseEvent) => {
			const atSec = Math.round(((performance.now() - (openedAt ?? t0)) / 1000) * 10) / 10;
			closeEvents.push({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean, atSec, byUs });
			if (!byUs) log(name, `ws closed by remote: code=${ev.code} reason=${ev.reason} after ${atSec}s`);
			finish();
		});
	});

	const observedSeconds = openedAt === null ? 0 : Math.round(((performance.now() - openedAt) / 1000) * 10) / 10;
	return {
		rpcWs: net.rpcWs,
		slotDurationMs,
		headerHashSelfCheck,
		connectMs: connectMs === null ? null : Math.round(connectMs),
		connectError,
		subscriptions,
		closeEvents,
		errorEvents,
		invalidMessages,
		observedSeconds,
		headEvents,
		finalizedEvents,
		headArrivalIntervalMs: summarize(headIntervals),
		finalizedArrivalIntervalMs: summarize(finalizedIntervals),
		best: { first: firstBest, last: lastBest },
		blocksAdvanced: firstBest !== null && lastBest !== null ? lastBest - firstBest : null,
		skippedBlocks,
		rewinds,
		duplicateHeights,
		parentMismatches,
		slotIntervalMs: summarize(slotIntervals),
		slotIntervalOverGapsMs: summarize(slotIntervalsOverGaps),
		slotSanityMaxSkewSec: maxSkewSec === null ? null : Math.round(maxSkewSec * 1000) / 1000,
		undecodedHeaders,
		babeVariants: countBy(variants),
		authorityIndexes: countBy(authorities),
		finalized: { first: firstFinalized, last: lastFinalized, skippedBlocks: finalizedSkipped },
		finalityLagBlocks: summarize(finalityLag),
		negativeLagCount,
		finalizedSlotAgeSec: summarize(finalizedSlotAgeSec),
		runtimeVersionEvents,
	};
}

const networks = selectedNetworks();
const startedAt = new Date().toISOString();
const results = await Promise.all(networks.map(async (n) => [n, await watchNetwork(n)] as const));
console.log(
	JSON.stringify(
		{
			script: "heads-ws",
			startedAt,
			finishedAt: new Date().toISOString(),
			node: process.version,
			seconds,
			networks: Object.fromEntries(results),
		},
		null,
		2,
	),
);
