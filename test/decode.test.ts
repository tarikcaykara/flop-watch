import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	babeFromHeader,
	decodeBabeConfiguration,
	decodeBabePreDigest,
	decodeCompact,
	encodeCompact,
	hexToBytes,
	isRpcHeader,
	type RpcHeader,
} from "../src/babe.ts";
import { blake2b256, headerHash } from "../src/blake2b.ts";

interface FixtureHeader {
	number: number;
	hash: string;
	header: RpcHeader;
	timestampMs: number;
	babe: { variant: number; authorityIndex: number; slot: string };
}
interface Fixtures {
	networks: Record<string, { babeConfiguration: string; headers: FixtureHeader[] }>;
}

const fixtures: Fixtures = JSON.parse(
	readFileSync(new URL("fixtures/headers.json", import.meta.url), "utf8"),
);
const networks = Object.entries(fixtures.networks);
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;

function firstHeader(network: string): RpcHeader {
	const header = fixtures.networks[network]?.headers[0]?.header;
	assert.ok(header, `fixture header for ${network}`);
	return header;
}

describe("blake2b256", () => {
	it("matches the published BLAKE2b-256 digests", () => {
		assert.equal(
			hex(blake2b256(new Uint8Array())),
			"0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
		);
		assert.equal(
			hex(blake2b256(new TextEncoder().encode("abc"))),
			"0xbddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
		);
	});

	it("handles inputs on and across the 128-byte block boundary", () => {
		// Reference values from Python's hashlib.blake2b(b"a" * n, digest_size=32).
		assert.equal(
			hex(blake2b256(new Uint8Array(128).fill(0x61))),
			"0xae2aa48507885c4c950fb809b2076f959cde9f8ea6da260d9a3587df33dac450",
		);
		assert.equal(
			hex(blake2b256(new Uint8Array(129).fill(0x61))),
			"0x2f64744a6de0d2c0b56e64cf6e29a5aaa255010d415d51c75ccc82f73dccd865",
		);
	});
});

describe("headerHash", () => {
	for (const [network, { headers }] of networks) {
		it(`reproduces the node's block hash for every ${network} fixture header`, () => {
			for (const { hash, header } of headers) assert.equal(headerHash(header), hash);
		});
	}

	it("throws on malformed hex", () => {
		assert.throws(
			() => headerHash({ ...firstHeader("testnet"), stateRoot: "0xzz" }),
			/invalid hex/,
		);
	});
});

describe("BABE pre-digest", () => {
	for (const [network, { headers }] of networks) {
		it(`decodes the slot and authority of every ${network} fixture header`, () => {
			for (const { header, timestampMs, babe } of headers) {
				const decoded = babeFromHeader(header);
				assert.ok(decoded);
				// BABE requires the block's timestamp inherent to fall in its slot.
				assert.equal(decoded.slot, BigInt(Math.floor(timestampMs / 1000)));
				assert.equal(decoded.variant, babe.variant);
				assert.equal(decoded.authorityIndex, babe.authorityIndex);
			}
		});
	}

	it("ignores the seal and any malformed or foreign log", () => {
		const header = firstHeader("devnet");
		const [preRuntime, seal] = header.digest.logs;
		assert.ok(preRuntime && seal);
		assert.equal(decodeBabePreDigest(seal), null, "seal (0x05) is not a pre-runtime digest");
		assert.equal(decodeBabePreDigest(preRuntime.slice(0, 20)), null, "truncated");
		assert.equal(
			decodeBabePreDigest(`0x0641555241${preRuntime.slice(12)}`),
			null,
			"AURA engine id",
		);
		assert.equal(decodeBabePreDigest("not hex"), null);
		assert.equal(babeFromHeader({ ...header, digest: { logs: [seal] } }), null);
	});
});

describe("SCALE compact", () => {
	// Examples from the SCALE codec specification, plus the largest supported value.
	const cases: Array<[number, string]> = [
		[0, "0x00"],
		[1, "0x04"],
		[42, "0xa8"],
		[69, "0x1501"],
		[65535, "0xfeff0300"],
		[2 ** 30 - 1, "0xfeffffff"],
	];

	it("encodes and decodes the specification examples", () => {
		for (const [value, encoded] of cases) {
			assert.equal(hex(encodeCompact(value)), encoded);
			assert.deepEqual(decodeCompact(hexToBytes(encoded), 0), {
				value,
				length: (encoded.length - 2) / 2,
			});
		}
	});

	it("rejects the big-integer mode, truncated input and out-of-range values", () => {
		assert.throws(() => decodeCompact(hexToBytes("0x0b00407a10f35a"), 0), /big-integer/);
		assert.throws(() => decodeCompact(hexToBytes("0x15"), 0), RangeError);
		assert.throws(() => encodeCompact(2 ** 30), /out of range/);
		assert.throws(() => encodeCompact(-1), /out of range/);
	});
});

describe("BabeApi_configuration", () => {
	for (const [network, { babeConfiguration }] of networks) {
		it(`decodes the documented 1 s slots and 3600-slot epochs on ${network}`, () => {
			assert.deepEqual(decodeBabeConfiguration(babeConfiguration), {
				slotDurationMs: 1000,
				epochLength: 3600,
			});
		});
	}

	it("throws on a truncated result", () => {
		assert.throws(() => decodeBabeConfiguration("0xe803"), RangeError);
	});
});

describe("isRpcHeader", () => {
	it("accepts a node header and rejects malformed shapes", () => {
		const header = firstHeader("testnet");
		assert.ok(isRpcHeader(header));
		assert.equal(isRpcHeader(null), false);
		assert.equal(isRpcHeader({ ...header, digest: undefined }), false);
		assert.equal(isRpcHeader({ ...header, digest: { logs: [1] } }), false);
		assert.equal(isRpcHeader({ ...header, number: 5 }), false);
	});
});
