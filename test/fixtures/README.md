# Test fixtures

## `headers.json`

Recorded on 2026-11-25 from the public RPCs (`https://rpc.devnet.flop.network`,
`https://testnet.flop.network`). Each network has three consecutive finalized blocks.

For each block:

- `hash`: from `chain_getBlockHash [number]`.
- `header`: from `chain_getHeader [hash]`.
- `timestampMs`: the `Timestamp.set` inherent, the first extrinsic of `chain_getBlock [hash]`.
- `babe`: the BABE pre-runtime digest (variant, authority index, slot).

The values were cross-checked independently of `src/` while recording:

- **Hashes.** Every `hash` equals Python's `hashlib.blake2b(digest_size=32)` over the
  SCALE-encoded header.
- **Timestamps.** The Devnet `timestampMs` and `hash` equal the explorer's
  `https://explorer.devnet.flop.network/api/blocks` entries.
- **Slots.** Every `babe.slot` equals `floor(timestampMs / 1000)`, the 1 s slot rule. The tests
  check the decoded slot against both `timestampMs` and the recorded `babe.slot`.
- **Variant and authority index.** `babe.variant` and `babe.authorityIndex` were decoded from the
  raw log bytes by a separate Python decoder written for the recording, not by `src/` or `poc/`.

`babeConfiguration` is the raw result of `state_call ["BabeApi_configuration", "0x"]` on each
network.
