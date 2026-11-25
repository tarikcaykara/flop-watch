// Shared helpers for the flop-watch proof-of-concept probes.
// Zero dependencies: Node >= 24 (type stripping, global fetch/WebSocket).
// Read-only: only JSON-RPC reads and HTTP GETs against public endpoints.

export type NetworkName = "devnet" | "testnet";

export interface NetworkConfig {
	rpcWs: string;
	rpcHttp: string;
	faucet: string;
	explorerApi: string;
	expectedGenesis: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
	devnet: {
		rpcWs: "wss://rpc.devnet.flop.network",
		rpcHttp: "https://rpc.devnet.flop.network",
		faucet: "https://faucet.devnet.flop.network",
		explorerApi: "https://explorer.devnet.flop.network/api",
		expectedGenesis: "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631",
	},
	testnet: {
		rpcWs: "wss://testnet.flop.network/",
		rpcHttp: "https://testnet.flop.network",
		faucet: "https://faucet.flop.network",
		explorerApi: "https://testnet.flopscan.io/api",
		expectedGenesis: "0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800",
	},
};

export const HTTP_TIMEOUT_MS = 10_000;
export const USER_AGENT = "flop-watch-poc/0.0.0 (read-only research probe)";

export function log(...args: unknown[]): void {
	console.error(new Date().toISOString(), ...args);
}

export function argValue(name: string): string | undefined {
	const prefix = `--${name}=`;
	const arg = process.argv.find((a) => a.startsWith(prefix));
	return arg?.slice(prefix.length);
}

export function selectedNetworks(): NetworkName[] {
	const raw = argValue("networks") ?? "devnet,testnet";
	const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
	for (const name of names) {
		if (!(name in NETWORKS)) throw new Error(`unknown network: ${name}`);
	}
	return names as NetworkName[];
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickHeaders(headers: Headers): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [key, value] of headers) {
		const k = key.toLowerCase();
		if (
			k === "server" ||
			k === "cf-cache-status" ||
			k === "retry-after" ||
			k.startsWith("ratelimit") ||
			k.startsWith("x-ratelimit")
		) {
			kept[k] = value;
		}
	}
	return kept;
}

function transportErrorKind(err: unknown): "timeout" | "network_error" {
	const name = typeof err === "object" && err !== null && "name" in err ? err.name : undefined;
	return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
}

function errorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = err.cause;
	if (typeof cause === "object" && cause !== null) {
		const detail = "code" in cause ? cause.code : "message" in cause ? cause.message : undefined;
		if (detail !== undefined) return `${err.message} (${String(detail)})`;
	}
	return err.message;
}

export interface RpcError {
	kind: "timeout" | "network_error" | "http_error" | "invalid_json" | "rpc_error";
	message: string;
	code?: number;
}

export interface RpcHttpResult {
	ms: number;
	httpStatus: number | null;
	result?: unknown;
	error?: RpcError;
	headers: Record<string, string>;
}

/** Tolerant nested property read: returns undefined when any step is not an object or lacks the key. */
export function at(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (typeof current !== "object" || current === null || !(key in current)) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
}

export interface RpcHeader {
	parentHash: string;
	number: string;
	stateRoot: string;
	extrinsicsRoot: string;
	digest: { logs: string[] };
}

export function isRpcHeader(value: unknown): value is RpcHeader {
	const logs = at(value, "digest", "logs");
	return (
		typeof at(value, "parentHash") === "string" &&
		typeof at(value, "number") === "string" &&
		typeof at(value, "stateRoot") === "string" &&
		typeof at(value, "extrinsicsRoot") === "string" &&
		Array.isArray(logs) &&
		logs.every((l) => typeof l === "string")
	);
}

let rpcId = 0;

/** JSON-RPC 2.0 POST. Never throws; failures are returned as `error`. */
export async function rpcHttp(
	url: string,
	method: string,
	params: unknown[] = [],
	timeoutMs = HTTP_TIMEOUT_MS,
): Promise<RpcHttpResult> {
	const t0 = performance.now();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": USER_AGENT },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		const ms = performance.now() - t0;
		const headers = pickHeaders(res.headers);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			const kind = res.ok ? "invalid_json" : "http_error";
			return { ms, httpStatus: res.status, error: { kind, message: text.slice(0, 200) }, headers };
		}
		const rpcErr = at(body, "error");
		if (rpcErr !== undefined && rpcErr !== null) {
			const message = String(at(rpcErr, "message") ?? "unknown");
			const code = at(rpcErr, "code");
			const error: RpcError = { kind: "rpc_error", message, code: typeof code === "number" ? code : undefined };
			return { ms, httpStatus: res.status, error, headers };
		}
		if (!res.ok) {
			return { ms, httpStatus: res.status, error: { kind: "http_error", message: text.slice(0, 200) }, headers };
		}
		return { ms, httpStatus: res.status, result: at(body, "result"), headers };
	} catch (err) {
		const ms = performance.now() - t0;
		return { ms, httpStatus: null, error: { kind: transportErrorKind(err), message: errorMessage(err) }, headers: {} };
	}
}

export interface GetJsonResult {
	ms: number;
	httpStatus: number | null;
	body: unknown;
	headers: Record<string, string>;
	error?: string;
}

/** HTTP GET expecting JSON. Never throws; `body` is null when the response is not JSON. */
export async function getJson(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<GetJsonResult> {
	const t0 = performance.now();
	try {
		const res = await fetch(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		const ms = performance.now() - t0;
		const headers = pickHeaders(res.headers);
		try {
			return { ms, httpStatus: res.status, body: JSON.parse(text), headers };
		} catch {
			return { ms, httpStatus: res.status, body: null, headers, error: `invalid_json: ${text.slice(0, 200)}` };
		}
	} catch (err) {
		const ms = performance.now() - t0;
		return { ms, httpStatus: null, body: null, headers: {}, error: `${transportErrorKind(err)}: ${errorMessage(err)}` };
	}
}

export interface Summary {
	n: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	avg: number;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Nearest-rank percentiles. Returns null for an empty input. */
export function summarize(nums: number[]): Summary | null {
	if (nums.length === 0) return null;
	const sorted = [...nums].sort((a, b) => a - b);
	const rank = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
	const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length;
	return {
		n: sorted.length,
		min: round(sorted[0]),
		p50: round(rank(50)),
		p95: round(rank(95)),
		max: round(sorted[sorted.length - 1]),
		avg: round(avg),
	};
}

export function countBy(values: Array<string | number | boolean | null | undefined>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const v of values) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
	return counts;
}

export function distinct<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
	if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("invalid hex");
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	let hex = "0x";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

function need(bytes: Uint8Array, offset: number, length: number): void {
	if (offset < 0 || offset + length > bytes.length) throw new Error("out of bounds");
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
	need(bytes, offset, 4);
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function readU64LE(bytes: Uint8Array, offset: number): bigint {
	return BigInt(readU32LE(bytes, offset)) | (BigInt(readU32LE(bytes, offset + 4)) << 32n);
}

/** SCALE compact integer (single-, two- and four-byte modes only). */
export function decodeCompact(bytes: Uint8Array, offset: number): { value: number; length: number } {
	need(bytes, offset, 1);
	const mode = bytes[offset] & 0b11;
	if (mode === 0b00) return { value: bytes[offset] >> 2, length: 1 };
	if (mode === 0b01) {
		need(bytes, offset, 2);
		return { value: (bytes[offset] | (bytes[offset + 1] << 8)) >> 2, length: 2 };
	}
	if (mode === 0b10) return { value: readU32LE(bytes, offset) >>> 2, length: 4 };
	throw new Error("compact big-integer mode not supported");
}

export function encodeCompact(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < 0) throw new Error("invalid compact value");
	if (value < 1 << 6) return Uint8Array.of(value << 2);
	if (value < 1 << 14) {
		const v = (value << 2) | 0b01;
		return Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
	}
	if (value < 2 ** 30) {
		const v = ((value << 2) | 0b10) >>> 0;
		return Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	}
	throw new Error("compact big-integer mode not supported");
}

export interface BabePreDigest {
	variant: 1 | 2 | 3;
	authorityIndex: number;
	slot: bigint;
}

/**
 * Decodes a `PreRuntime` digest log from BABE:
 * 0x06 | "BABE" | compact(len) | variant u8 | authorityIndex u32 LE | slot u64 LE | ...
 */
export function decodeBabePreDigest(logHex: string): BabePreDigest | null {
	let bytes: Uint8Array;
	try {
		bytes = hexToBytes(logHex);
	} catch {
		return null;
	}
	if (bytes.length < 5 || bytes[0] !== 0x06) return null;
	if (bytes[1] !== 0x42 || bytes[2] !== 0x41 || bytes[3] !== 0x42 || bytes[4] !== 0x45) return null;
	try {
		const len = decodeCompact(bytes, 5);
		const start = 5 + len.length;
		if (len.value < 13 || start + len.value > bytes.length) return null;
		const variant = bytes[start];
		if (variant !== 1 && variant !== 2 && variant !== 3) return null;
		return { variant, authorityIndex: readU32LE(bytes, start + 1), slot: readU64LE(bytes, start + 5) };
	} catch {
		return null;
	}
}

// --- BLAKE2b-256 (RFC 7693), needed to compute block hashes from headers ---

const M64 = (1n << 64n) - 1n;
const IV = [
	0x6a09e667f3bcc908n,
	0xbb67ae8584caa73bn,
	0x3c6ef372fe94f82bn,
	0xa54ff53a5f1d36f1n,
	0x510e527fade682d1n,
	0x9b05688c2b3e6c1fn,
	0x1f83d9abfb41bd6bn,
	0x5be0cd19137e2179n,
];
const SIGMA = [
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
	[14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
	[11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
	[7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
	[9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
	[2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
	[12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
	[13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
	[6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
	[10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M64;

function mix(v: bigint[], a: number, b: number, c: number, d: number, x: bigint, y: bigint): void {
	v[a] = (v[a] + v[b] + x) & M64;
	v[d] = rotr(v[d] ^ v[a], 32n);
	v[c] = (v[c] + v[d]) & M64;
	v[b] = rotr(v[b] ^ v[c], 24n);
	v[a] = (v[a] + v[b] + y) & M64;
	v[d] = rotr(v[d] ^ v[a], 16n);
	v[c] = (v[c] + v[d]) & M64;
	v[b] = rotr(v[b] ^ v[c], 63n);
}

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
	const m = Array.from({ length: 16 }, (_, i) => readU64LE(block, i * 8));
	const v = [...h, ...IV];
	v[12] ^= t & M64;
	v[13] ^= t >> 64n;
	if (last) v[14] ^= M64;
	for (let r = 0; r < 12; r++) {
		const s = SIGMA[r % 10];
		mix(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
		mix(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
		mix(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
		mix(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
		mix(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
		mix(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
		mix(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
		mix(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
	}
	for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

export function blake2b256(input: Uint8Array): Uint8Array {
	const h = IV.slice();
	h[0] ^= 0x01010000n ^ 32n;
	const blocks = Math.max(1, Math.ceil(input.length / 128));
	let t = 0n;
	for (let i = 0; i < blocks; i++) {
		const chunk = input.subarray(i * 128, (i + 1) * 128);
		const block = new Uint8Array(128);
		block.set(chunk);
		t += BigInt(chunk.length);
		compress(h, block, t, i === blocks - 1);
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) {
		for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(8 * j)) & 0xffn);
	}
	return out;
}

/** Block hash = blake2b-256(SCALE(header)); the digest logs are already SCALE-encoded. */
export function headerHash(header: RpcHeader): string {
	const parts = [
		hexToBytes(header.parentHash),
		encodeCompact(Number.parseInt(header.number, 16)),
		hexToBytes(header.stateRoot),
		hexToBytes(header.extrinsicsRoot),
		encodeCompact(header.digest.logs.length),
		...header.digest.logs.map(hexToBytes),
	];
	const encoded = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		encoded.set(p, offset);
		offset += p.length;
	}
	return bytesToHex(blake2b256(encoded));
}

/** First BABE pre-runtime digest in a header, or null. */
export function babeFromHeader(header: RpcHeader): BabePreDigest | null {
	for (const logHex of header.digest?.logs ?? []) {
		const decoded = decodeBabePreDigest(logHex);
		if (decoded) return decoded;
	}
	return null;
}

/** Decodes slot duration (ms) and epoch length (slots): the first two u64 LE of BabeConfiguration. */
export function decodeBabeConfiguration(resultHex: string): { slotDurationMs: number; epochLength: number } {
	const bytes = hexToBytes(resultHex);
	return { slotDurationMs: Number(readU64LE(bytes, 0)), epochLength: Number(readU64LE(bytes, 8)) };
}
