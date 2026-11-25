// BLAKE2b-256 (RFC 7693) and the Substrate block hash. node:crypto only offers BLAKE2b with a
// fixed 512-bit output, and a 256-bit digest is not a truncated 512-bit one (the output length is
// part of the parameter block). Headers arrive about once a second per network, so a compact
// BigInt implementation is fast enough.

import { encodeCompact, hexToBytes, parseBlockNumber, type RpcHeader } from "./babe.ts";

const MASK = (1n << 64n) - 1n;
const IV = [
	0x6a09e667f3bcc908n,
	0xbb67ae8584caa73bn,
	0x3c6ef372fe94f82bn,
	0xa54ff53a5f1d36f1n,
	0x510e527fade682d1n,
	0x9b05688c2b3e6c1fn,
	0x1f83d9abfb41bd6bn,
	0x5be0cd19137e2179n,
] as const;
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
] as const;
// G's (a, b, c, d) word indexes: four column steps, then four diagonal steps.
const STEPS = [
	[0, 4, 8, 12],
	[1, 5, 9, 13],
	[2, 6, 10, 14],
	[3, 7, 11, 15],
	[0, 5, 10, 15],
	[1, 6, 11, 12],
	[2, 7, 8, 13],
	[3, 4, 9, 14],
] as const;

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

/** Every index below is fixed by the algorithm, so a miss is a bug: fail loudly, never use 0. */
function must<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("BLAKE2b: index out of range");
	return value;
}

function compress(h: bigint[], block: Uint8Array, counter: bigint, last: boolean): void {
	const data = new DataView(block.buffer, block.byteOffset, block.byteLength);
	const m = Array.from({ length: 16 }, (_, i) => data.getBigUint64(i * 8, true));
	const v = [...h, ...IV];
	v[12] = must(v[12]) ^ (counter & MASK);
	v[13] = must(v[13]) ^ (counter >> 64n);
	if (last) v[14] = must(v[14]) ^ MASK;
	for (let round = 0; round < 12; round++) {
		const s = must(SIGMA[round % 10]);
		STEPS.forEach(([a, b, c, d], step) => {
			const x = must(m[must(s[2 * step])]);
			const y = must(m[must(s[2 * step + 1])]);
			let va = must(v[a]);
			let vb = must(v[b]);
			let vc = must(v[c]);
			let vd = must(v[d]);
			va = (va + vb + x) & MASK;
			vd = rotr(vd ^ va, 32n);
			vc = (vc + vd) & MASK;
			vb = rotr(vb ^ vc, 24n);
			va = (va + vb + y) & MASK;
			vd = rotr(vd ^ va, 16n);
			vc = (vc + vd) & MASK;
			vb = rotr(vb ^ vc, 63n);
			v[a] = va;
			v[b] = vb;
			v[c] = vc;
			v[d] = vd;
		});
	}
	for (let i = 0; i < 8; i++) h[i] = must(h[i]) ^ must(v[i]) ^ must(v[i + 8]);
}

/** BLAKE2b with a 32-byte digest and no key. */
export function blake2b256(input: Uint8Array): Uint8Array {
	const h: bigint[] = [...IV];
	h[0] = IV[0] ^ 0x01010000n ^ 32n; // parameter block: digest length 32, no key, fanout 1, depth 1
	const blocks = Math.max(1, Math.ceil(input.length / 128));
	let counter = 0n;
	for (let i = 0; i < blocks; i++) {
		const chunk = input.subarray(i * 128, (i + 1) * 128);
		const block = new Uint8Array(128);
		block.set(chunk);
		counter += BigInt(chunk.length);
		compress(h, block, counter, i === blocks - 1);
	}
	const out = new Uint8Array(32);
	const data = new DataView(out.buffer);
	for (let i = 0; i < 4; i++) data.setBigUint64(i * 8, must(h[i]), true);
	return out;
}

/**
 * The block hash: BLAKE2b-256 of the SCALE-encoded header
 * (`parentHash | compact(number) | stateRoot | extrinsicsRoot | compact(logs) | logs…`).
 * The digest logs are already SCALE-encoded. Throws on malformed hex or block number.
 */
export function headerHash(header: RpcHeader): string {
	const encoded = Buffer.concat([
		hexToBytes(header.parentHash),
		encodeCompact(parseBlockNumber(header.number)),
		hexToBytes(header.stateRoot),
		hexToBytes(header.extrinsicsRoot),
		encodeCompact(header.digest.logs.length),
		...header.digest.logs.map(hexToBytes),
	]);
	return `0x${Buffer.from(blake2b256(encoded)).toString("hex")}`;
}
