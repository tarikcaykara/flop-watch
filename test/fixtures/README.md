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

## `services.json`

The faucet and explorer response bodies recorded by the research probe, copied unchanged:

- `poc/results/2026-11-25/services.json`, the `firstBodies` of each network, recorded at about
  19:00Z (`recordedAt`);
- the Testnet `/chain` 200 body from `poc/results/2026-11-25/services-testnet-recheck.json`,
  recorded at about 19:13Z (`recheckedAt`). The first run got a 503 there.

Layout: `networks.<devnet|testnet>.<target>.<HTTP status>` → body, where `<target>` is
`faucet_limits`, `faucet_health`, `faucet_chain` or `explorer_stats`.

| Network | `faucet_limits` | `faucet_health` | `faucet_chain` | `explorer_stats` |
|---|---|---|---|---|
| devnet | 200 | 200 | 200 | 200 |
| testnet | 200 | 503 | 503, 200 | 503 |

The bodies are verbatim, so they include the public faucet and sponsor signer addresses. The
parsers never read them.

No `/limits` body with `faucet.status: "unknown"` was recorded. The tests build that state from a
recorded body, with the sponsor shape documented in `docs/research.md` §6.

## Users

The unit tests read both files. The fake FLOP service of the stack e2e (`test/e2e/fake-flop.ts`)
serves them to the collector; its header comment lists where it departs from them.
