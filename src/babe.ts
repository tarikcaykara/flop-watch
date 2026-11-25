// Pure decoding of the few SCALE structures flop-watch reads: compact integers, block headers as
// returned by the JSON-RPC API, the BABE pre-runtime digest and BabeApi_configuration.
// No metadata is needed, so runtime upgrades cannot break it (architecture §5).

/** A block header as returned by `chain_getHeader` and the head subscriptions. */
export interface RpcHeader {
	readonly parentHash: string;
	/** Hex-encoded block number, e.g. `"0x1ace5b"`. */
	readonly number: string;
	readonly stateRoot: string;
	readonly extrinsicsRoot: string;
	/** Each log is a SCALE-encoded `DigestItem`, hex-encoded. */
	readonly digest: { readonly logs: readonly string[] };
}

export interface BabePreDigest {
	/** 1 Primary, 2 SecondaryPlain, 3 SecondaryVRF. */
	readonly variant: 1 | 2 | 3;
	readonly authorityIndex: number;
	readonly slot: bigint;
}

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const PRE_RUNTIME = 0x06;
const BABE_ENGINE_ID = [0x42, 0x41, 0x42, 0x45]; // "BABE"

export function isRpcHeader(value: unknown): value is RpcHeader {
	if (typeof value !== "object" || value === null) return false;
	if (!("parentHash" in value && "number" in value && "stateRoot" in value)) return false;
	if (!("extrinsicsRoot" in value && "digest" in value)) return false;
	const { parentHash, number, stateRoot, extrinsicsRoot, digest } = value;
	if (typeof digest !== "object" || digest === null || !("logs" in digest)) return false;
	const { logs } = digest;
	return (
		[parentHash, number, stateRoot, extrinsicsRoot].every((v) => typeof v === "string") &&
		Array.isArray(logs) &&
		logs.every((log) => typeof log === "string")
	);
}

/** Decodes 0x-prefixed hex; throws on anything else. */
export function hexToBytes(hex: string): Uint8Array {
	if (!HEX_RE.test(hex)) throw new Error(`invalid hex: ${hex.slice(0, 20)}`);
	return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Decodes a SCALE compact integer at `offset` in the single-, two- and four-byte modes.
 * Throws on the big-integer mode (values ≥ 2^30) and on truncated input.
 */
export function decodeCompact(
	bytes: Uint8Array,
	offset: number,
): { value: number; length: number } {
	const data = view(bytes);
	const first = data.getUint8(offset);
	switch (first & 0b11) {
		case 0b00:
			return { value: first >> 2, length: 1 };
		case 0b01:
			return { value: data.getUint16(offset, true) >> 2, length: 2 };
		case 0b10:
			return { value: data.getUint32(offset, true) >>> 2, length: 4 };
		default:
			throw new Error("SCALE compact big-integer mode is not supported");
	}
}

/** Encodes a SCALE compact integer below 2^30. */
export function encodeCompact(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < 0 || value >= 2 ** 30) {
		throw new Error(`compact value out of range: ${value}`);
	}
	if (value < 2 ** 6) return Uint8Array.of(value << 2);
	const out = new Uint8Array(value < 2 ** 14 ? 2 : 4);
	if (out.length === 2) view(out).setUint16(0, (value << 2) | 0b01, true);
	else view(out).setUint32(0, ((value << 2) | 0b10) >>> 0, true);
	return out;
}

/**
 * Decodes a BABE pre-runtime digest log:
 * `0x06 | "BABE" | compact(length) | variant u8 | authorityIndex u32 LE | slot u64 LE | …`.
 * Returns null for any other log or a malformed one.
 */
export function decodeBabePreDigest(logHex: string): BabePreDigest | null {
	try {
		const bytes = hexToBytes(logHex);
		if (bytes[0] !== PRE_RUNTIME || !BABE_ENGINE_ID.every((b, i) => bytes[i + 1] === b))
			return null;
		const payload = decodeCompact(bytes, 5);
		const start = 5 + payload.length;
		if (payload.value < 13 || start + payload.value > bytes.length) return null;
		const data = view(bytes);
		const variant = data.getUint8(start);
		if (variant !== 1 && variant !== 2 && variant !== 3) return null;
		return {
			variant,
			authorityIndex: data.getUint32(start + 1, true),
			slot: data.getBigUint64(start + 5, true),
		};
	} catch {
		return null;
	}
}

/** The first BABE pre-runtime digest of a header, or null when there is none. */
export function babeFromHeader(header: RpcHeader): BabePreDigest | null {
	for (const log of header.digest.logs) {
		const decoded = decodeBabePreDigest(log);
		if (decoded) return decoded;
	}
	return null;
}

/**
 * Decodes the result of `state_call("BabeApi_configuration", "0x")`: its first two fields are the
 * slot duration (ms) and the epoch length (slots), both u64 LE. Throws on truncated input.
 */
export function decodeBabeConfiguration(resultHex: string): {
	slotDurationMs: number;
	epochLength: number;
} {
	const data = view(hexToBytes(resultHex));
	return {
		slotDurationMs: Number(data.getBigUint64(0, true)),
		epochLength: Number(data.getBigUint64(8, true)),
	};
}
