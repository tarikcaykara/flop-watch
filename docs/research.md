# flop-watch — research

Research for an independent, read-only observability toolkit for FLOP Network Devnet and Testnet.
Design: [architecture.md](architecture.md). Scope and go/no-go: [mvp.md](mvp.md).

## 1. Scope and method

- **Verification date:** 2026-11-25. Every live observation was made on that day from a single
  vantage point: one client connection, reaching the endpoints through Cloudflare.
- **Question:** what can an outside observer measure about FLOP RPC, finality, the faucet and the
  explorer/indexer? What do the official tools already cover? Is a continuous monitor worth
  building?
- **Tags.** Every claim carries one of these tags:
  - `[Verified 2026-11-25]` — observed live.
  - `[Documented]` — taken only from official text, with a link.
  - `[Inference]` — our interpretation.
  - `[Decision]` — a design choice made for flop-watch.
- **Reproduce the PoCs.** You need Node ≥ 24; there is nothing to install. Run each from the repo
  root:
  - `node poc/rpc-http.mts > rpc-http.json`: about 35 s.
  - `node poc/heads-ws.mts [--seconds=300] > heads-ws.json`: 300 s by default.
  - `node poc/services.mts > services.json`: about 5 min.

  Each script also accepts `--networks=devnet,testnet`. Each prints one JSON document to stdout and
  logs to stderr. The scripts make only JSON-RPC reads and HTTP GETs. They never call faucet claim,
  gateway enrollment or inference endpoints.
- **Recorded outputs** are in [`poc/results/2026-11-25/`](../poc/results/2026-11-25/). Sections 5
  and 10 summarise them.

## 2. FLOP Network architecture

- **Consensus.** FLOP is a Substrate chain. Blocks are produced by **BABE**; finality comes from
  **AlephBFT**, not GRANDPA. [Documented: [run-validator](https://docs.flop.network/docs/run-validator),
  [technology-and-chain](https://docs.flop.network/docs/technology-and-chain)]
  - `rpc_methods` returns 128 methods on both networks, with no `grandpa_*` method. It does include
    `chainHead_v1_follow`, `state_subscribeRuntimeVersion` and `system_syncState`.
    [Verified 2026-11-25]
  - `state_getRuntimeVersion.implName` is `zkv-node` on both networks.
    [Verified 2026-11-25] This suggests a node derived from zkVerify. [Inference]
- **Slots and epochs.** `state_call("BabeApi_configuration", "0x")` returns a slot duration of
  1000 ms and an epoch length of 3600 slots on both networks. [Verified 2026-11-25] This matches the
  documented 1 s block time and 1 h epoch.
  [Documented: [protocol-parameters](https://docs.flop.network/docs/protocol-parameters)]
- **Finality thresholds.** `FinalityLagWarn = 30`, `FinalityFreezeThreshold = 120` and
  `MaxFinalityStall = 3600` blocks.
  [Documented: [yellowpaper params](https://raw.githubusercontent.com/flop-labs/yellowpaper/main/params/flop-protocol-params.yaml)]
  - The Devnet explorer `/api/stats` echoes the same values as
    `finality.thresholds{warnBlocks: 30, freezeBlocks: 120, maxStallBlocks: 3600}`.
    [Verified 2026-11-25]
  - No finality-latency target is published.
    [Documented: [protocol-parameters](https://docs.flop.network/docs/protocol-parameters)]
- **Authorities.** In 5 minutes of headers, the BABE pre-digests named authority indexes 0–12 on
  Devnet (13 authorities) and 0–5 on Testnet (6 authorities). [Verified 2026-11-25] The Testnet
  count matches the six founding validators.
  [Documented: [Testnet](https://docs.flop.network/networks/testnet)]

| | Devnet | Testnet |
|---|---|---|
| Status | Live, agent tooling, gateway and faucet [Documented: [llms.txt](https://flop.network/llms.txt)] | Opened 2026-11-24, unscored, "may restart or reset" [Documented: [Testnet](https://docs.flop.network/networks/testnet)] |
| RPC | `wss://rpc.devnet.flop.network`, `https://rpc.devnet.flop.network`. "Safe methods only and rate-limited", with no numbers published [Documented: [llms.txt](https://flop.network/llms.txt)] | `wss://testnet.flop.network/`, `https://testnet.flop.network`. No formal RPC policy published [Documented: [technology-and-chain](https://docs.flop.network/docs/technology-and-chain)] |
| `system_chain` | `FLOP Devnet` [Verified 2026-11-25] | `FLOP Testnet` [Verified 2026-11-25] |
| Genesis | `0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631` [Verified 2026-11-25] | `0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800` [Verified 2026-11-25; Documented] |
| `specName` / `specVersion` | `tzkv-runtime` / 1014034 [Verified 2026-11-25] | `flop-testnet` / 1014035 [Verified 2026-11-25] |
| Height | about 4.64 M [Verified 2026-11-25] | about 108 k [Verified 2026-11-25] |
| `system_health.peers` | 26 [Verified 2026-11-25] | 16–19 [Verified 2026-11-25] |

- **Resets and upgrades.** There is no announcement channel for resets or runtime upgrades.
  [Documented: [Testnet](https://docs.flop.network/networks/testnet),
  [releases](https://github.com/flop-labs/network/releases)]
  - A reset would change the genesis hash. [Inference]
  - A runtime upgrade is visible only as a change in `specVersion`, which the RPC pushes through
    `state_subscribeRuntimeVersion`. [Verified 2026-11-25: subscription accepted]
  - Voucher earning starts at "a future upgrade", so a Testnet `specVersion` bump is expected.
    [Documented: [Testnet](https://docs.flop.network/networks/testnet)]
- **No inside view.** FLOP publishes no node metrics, no telemetry and no official status page.
  The validator Prometheus port 9615 stays on loopback, and there is no public telemetry host.
  [Documented: [run-validator](https://docs.flop.network/docs/run-validator)] flop-watch can only
  observe from outside.

## 3. Official sources

| Source | What it provides | Read |
|---|---|---|
| [docs.flop.network/networks/testnet](https://docs.flop.network/networks/testnet) | Testnet identity, genesis, reset warning, bootnodes, chain-spec checksum | 2026-11-25 |
| [docs: technology-and-chain](https://docs.flop.network/docs/technology-and-chain) | Chain technology; no formal Testnet RPC policy | 2026-11-25 |
| [docs: run-validator](https://docs.flop.network/docs/run-validator) | AlephBFT finality; node Prometheus on loopback (9615) | 2026-11-25 |
| [docs: protocol-parameters](https://docs.flop.network/docs/protocol-parameters) | 1 s block time, 1 h epoch, no finality-latency target | 2026-11-25 |
| [docs: sdk-references](https://docs.flop.network/docs/sdk-references) | SDK/CLI reference and documented versions | 2026-11-25 |
| [flop.network/llms.txt](https://flop.network/llms.txt) | Agent guide: endpoints, faucet API, client minimums, back-off rules | 2026-11-25 |
| [yellowpaper params](https://raw.githubusercontent.com/flop-labs/yellowpaper/main/params/flop-protocol-params.yaml) | Protocol constants, including finality thresholds | 2026-11-25 |
| [github.com/flop-labs/network](https://github.com/flop-labs/network) | Issues, releases, `networks/testnet.md` | 2026-11-25 |
| [flop.network/releases.json](https://flop.network/releases.json) | Container image pins and `notices` for component floors | 2026-11-25 |
| [@flop-labs/sdk 0.12.0](https://unpkg.com/@flop-labs/sdk@0.12.0/) | SDK source: connect, runtime compatibility, network profiles | 2026-11-25 |
| [@flop-labs/cli](https://www.npmjs.com/package/@flop-labs/cli) | CLI 0.9.0: `network status`, `doctor` | 2026-11-25 |
| [faucet.flop.network](https://faucet.flop.network/) (HTML) | Testnet faucet web UI; its inline script holds the claim-readiness logic | 2026-11-25 |
| [flop.network/mcp-config.json](https://flop.network/mcp-config.json) | Hosted MCP tool list (Devnet) | 2026-11-25 |

## 4. Verified endpoints

All statuses below were observed on 2026-11-25. "Not called" marks write or credentialed endpoints
that flop-watch must never use.

| Network | Endpoint | Method / path | Auth | Status 2026-11-25 | Notes |
|---|---|---|---|---|---|
| Testnet | `wss://testnet.flop.network/` | JSON-RPC over WS | none | OK | `chain_subscribeNewHeads`, `chain_subscribeFinalizedHeads`, `state_subscribeRuntimeVersion` accepted; 300 s with no drop |
| Testnet | `https://testnet.flop.network` | JSON-RPC POST | none | 200 (34/34) | `server: cloudflare`, no rate-limit headers |
| Testnet | `https://faucet.flop.network` | GET `/limits` | none | 200 | `cache-control: no-store`; schema in §6 |
| Testnet | `https://faucet.flop.network` | GET `/health` | none | **503** | JSON body `status: degraded`, `ready: false`, `retry-after: 60` |
| Testnet | `https://faucet.flop.network` | GET `/chain` | none | 200; one **503** | 503 body: `{"error":"Faucet RPC did not verify the release genesis"}` at about 19:00:16Z; 10/10 rechecks at about 19:08Z returned 200 |
| Testnet | `https://faucet.flop.network` | POST `/v1/testnet/agent-claims` | signed claim | not called | write endpoint |
| Testnet | `https://testnet.flopscan.io/api` | GET `/stats`, `/blocks`, `/search?q=` | none | **503** | `{"error":"Era-T reader unavailable"}` for the whole run |
| Testnet | `https://testnet.flopscan.io/api/health` | GET | none | 404 | no health route |
| Testnet | `https://gateway.testnet.flop.network` | any | — | DNS `ENOTFOUND` | listed in the SDK profile; llms.txt says there is no Testnet gateway yet |
| Testnet | `https://snapshots.flop.network/testnet/archive/latest.json` | GET | none | 404 | archive feed "awaits publication" |
| Devnet | `wss://rpc.devnet.flop.network` | JSON-RPC over WS | none | OK | subscriptions accepted; heads delivered with gaps (§10) |
| Devnet | `https://rpc.devnet.flop.network` | JSON-RPC POST | none | 200 (34/34) | "rate-limited" [Documented], but no rate-limit headers observed |
| Devnet | `https://faucet.devnet.flop.network` | GET `/limits`, `/chain` | none | 200 | |
| Devnet | `https://faucet.devnet.flop.network` | GET `/health` | none | 200 | `status: degraded`, `ready: false` |
| Devnet | `https://faucet.devnet.flop.network` | POST `/fund`, POST `/sponsor/*` | — | not called | write endpoints |
| Devnet | `https://explorer.devnet.flop.network/api/stats` | GET | none | 200 | `ratelimit-policy: 120;w=60` (120 requests per 60 s) |
| Devnet | `https://explorer.devnet.flop.network/api/health` | GET | none | 200 | `indexedHead`, `chainHead`, `headLag`, `writer.genesis` |
| Devnet | `https://api.flop.network/health` | GET | none | 200 | `network.expected_genesis_hash` / `observed_genesis_hash`, `dependencies` |
| Devnet | `https://api.flop.network/v1/models` | GET | none | 200 | keyless model list |
| Devnet | `https://api.flop.network/v1/*` inference, `/v1/enroll/*` | — | API key / signed wallet | not called | spends broker quota |
| Devnet | `https://mcp.flop.network/health` | GET | none | 200 | `readOnly: true`, `dependencies` |
| Devnet | `https://snapshots.flop.network/devnet-ts/archive/latest.json` | GET | none | 200 | `schema: flop.rpc-snapshot.v1` |

## 5. SDK, CLI and client capabilities

**`@flop-labs/sdk` 0.12.0**
[[unpkg](https://unpkg.com/@flop-labs/sdk@0.12.0/), [docs](https://docs.flop.network/docs/sdk-references)]

- **Package.** About 17.9 MB unpacked [Verified 2026-11-25: npm metadata], about 20 MB on disk
  after install [Verified 2026-11-25].
  - Dependencies: `@polkadot/api` ^17, `@polkadot/types`, `@polkadot/keyring`,
    `@polkadot/util-crypto`, `@polkadot/wasm-crypto`, `@solana/kit`, `langfuse`, `@noble/curves`
    and `@flop-labs/client`.
  - No `engines` field. [Verified 2026-11-25]
- **Read methods.** `FlopClient` offers `health()` (which calls `system_health`), `getAccountInfo`
  and `getBalance`. There are no helpers for heads, finality or subscriptions; for those you use the
  raw polkadot-js `ApiPromise`. No SDK method reads the faucet `/limits`. [Verified 2026-11-25: source]
- **`connectFlopApi`.** It wraps `ApiPromise.create`: three connect attempts, a 10 s overall
  readiness bound by default, and an optional `expectedGenesisHash` pin. [Verified 2026-11-25:
  `dist/connect.js`]
- **Runtime allow-list.** `FlopClient` calls `assertSupportedSpecVersion` on connect and throws
  `RUNTIME_INCOMPATIBLE` for any `specVersion` that is not on an exact allow-list
  (`SUPPORTED_SPEC_VERSIONS`).
  - The 0.12.0 list has 34 entries up to 1014038, including 1014034 and 1014035. Rejected
    candidates such as 1014028 and 1014030 are excluded. [Verified 2026-11-25:
    `dist/runtime-compatibility.js`]
  - So a monitor built on `FlopClient` stops working at the first unlisted runtime upgrade, which is
    exactly the event a monitor must survive. [Inference]
- **Network profiles** (`dist/chain.js`). The Testnet profile pins the genesis
  (`genesisPolicy: "pin-before-live"`); the Devnet profile does not (`compare-services`). The Testnet
  profile lists `gateway.testnet.flop.network`, which does not resolve. [Verified 2026-11-25]

**SDK evaluation.** This was run in a throwaway directory outside the repo (`/tmp`, since deleted)
with Node v24.11.0 on macOS arm64, via `pnpm add @flop-labs/sdk@0.12.0`. [Verified 2026-11-25]

| Measurement | Value |
|---|---|
| `node_modules` size (`du -sh`) | 232 MB |
| Packages (`pnpm ls --depth Infinity --parseable`) | 116, plus the root project |
| Cold `import("@flop-labs/sdk")` | 909 ms on the first run, 717 ms on the second |
| RSS before import / after import | 66 MB / 366 MB |
| `connectFlopApi("wss://testnet.flop.network", …, {expectedGenesisHash})`, connect plus metadata | 2066 ms / 1938 ms |
| RSS after connect | 316 MB |
| `SUPPORTED_SPEC_VERSIONS` includes 1014035 / 1014034 | yes / yes |

For comparison, a bare Node 24 process running a `.mts` file uses about 66 MB RSS. Importing the SDK
alone adds about 300 MB. [Verified 2026-11-25]

**`@flop-labs/cli` 0.9.0**
[[npm](https://www.npmjs.com/package/@flop-labs/cli)]

- `network status --json` is a one-shot check: RPC chain, genesis and runtime; faucet `/chain` and
  `/health` readiness; and whether the faucet and RPC genesis match. It has no latency, head,
  finality, history or `/limits` capacity. [Verified 2026-11-25: source]
- `doctor` checks that the local setup is ready. [Verified 2026-11-25: source]

**Docs drift.**

- The docs baseline lists sdk 0.10.0 and cli 0.8.2.
  [Documented: [sdk-references](https://docs.flop.network/docs/sdk-references)]
- llms.txt requires sdk ≥ 0.11.0 and cli ≥ 0.8.3 for Testnet.
  [Documented: [llms.txt](https://flop.network/llms.txt)]
- npm serves sdk 0.12.0 and cli 0.9.0. [Verified 2026-11-25]

**Gateway and MCP (Devnet only)** [Verified 2026-11-25]

- `https://api.flop.network/health` reports the expected and observed genesis hashes and its
  dependencies.
- `/v1/models` needs no key. `@flop-labs/client` sends auth only on requests with a body.
  [Verified 2026-11-25: source]
- `https://mcp.flop.network/health` has a similar shape. The hosted MCP lists `flop_health`,
  `flop_get_stats` and `flop_get_block`. [Documented: [mcp-config.json](https://flop.network/mcp-config.json)]
  We did not exercise the tools themselves.
- Inference needs an API key and spends broker quota. There is no Testnet gateway.
  [Documented: [llms.txt](https://flop.network/llms.txt)]

## 6. Available metrics and data sources

Categories:

- **measured**: flop-watch observes it directly, such as timings or reachability.
- **reported**: a FLOP service or node states it.
- **derived**: computed by a rule from other signals.

| Metric idea | Source call | Category | Cadence | Caveat |
|---|---|---|---|---|
| RPC reachability and latency (HTTP) | `chain_getHeader`, `system_health` POST | measured | 30 s | One vantage point; Cloudflare edge included in timing |
| RPC reachability and latency (WS) | `system_health` over the open WS | measured | 30 s | Same as above |
| WS connection stability | connect/close events | measured | event | Close codes are the only evidence of server-side drops |
| Best / finalized head number | `chain_subscribeNewHeads`, `chain_subscribeFinalizedHeads` | reported (node) | push, about 1/s | Devnet notifications skip and rewind (§10) |
| Head arrival age | local receive time of the last notification | measured | push | Reflects delivery to us, not block production |
| Finality lag (blocks) | best − finalized | derived | push | Can go negative on Devnet (backend mix, §10) |
| Block interval | BABE pre-digest slot deltas × slot duration | reported (chain) | push | Only for consecutive blocks with a verified parent link |
| Missed slots | slot delta > 1 slot | derived | push | None observed in 5 min |
| Genesis / spec identity | `chain_getBlockHash [0]`, `state_getRuntimeVersion`, runtime-version subscription | reported | reconnect + push | A reset is inferred from a genesis change |
| Node peers / syncing | `system_health` | reported | 30 s | Describes the RPC node behind the load balancer, not the network |
| Faucet status, stale flag, `asOf` | GET `/limits` | reported | 60 s | `asOf` lags by up to about 5 min (§10) |
| Faucet balance, min balance, daily cap, pending grants | GET `/limits` | reported | 60 s | FLOP amounts are decimal strings |
| Sponsor lane status | GET `/limits` `sponsor.{miner,validator}.status` | reported | 60 s | Enum not documented |
| Faucet readiness and dependencies | GET `/health` | reported | 60 s | Returns 503 when degraded; `ready` is per-client (`readinessScope`) |
| Faucet network identity | GET `/chain` | reported | 60 s | A non-2xx response disables the official claim UI (§7) |
| Claim readiness as the official UI sees it | `/limits` + `/chain` | derived | 60 s | Mirrors the UI logic in §7, not the faucet backend |
| Explorer indexer head / finality view | GET explorer `/api/stats` | reported | 60 s | Undocumented API; Testnet returned 503 throughout |
| Explorer indexer lag | chain best − explorer `latestBlockNumber` | derived | 60 s | Clock skew between the two sources |

Fields read from `/limits`, observed on both networks [Verified 2026-11-25]:

- Top level: `network`, `asOf`, `stale`.
- `faucet`: `status`, `signer`, `balanceFlop`, `minBalanceFlop`,
  `dailyCap{limitFlop,usedFlop,remainingFlop}`, `pendingGrants`, `anonymous`, `linked`,
  `agent{grantFlop,claimPath,rolling24HourCapFlop,cooldownSeconds,rolloverRequiresSpend}`,
  `perClient`.
- `sponsor.miner` and `sponsor.validator`: `status`, `signer`, `spendableFlop`,
  `capacity{signers,used,max,active,unbonding,other}`, `dailyNewSponsorships`, `dailyStakeBudget`,
  `automatic`.

Observed values:

- `faucet.status`: `open` (this run), `unknown`, which comes with sponsors
  `{"status":"unknown","reason":"sponsor_unavailable"}` (observed earlier the same day), and
  `low_balance` ([#1364](https://github.com/flop-labs/network/issues/1364)).
- Sponsor statuses: `open`, `automatic_full`, `positions_full`, `unknown`.
- `/health` `dependencies` keys: `signer`, `indexer`, `ip_classification`, `funding`, `signing`.
  The first four carry `{ok, reason?, error?, details?}`. `signing` has no `ok` field.
- `/health` `status` values: `degraded`, `disconnected` (Testnet, once). [Verified 2026-11-25]

## 7. Diagnosis of the maintainer's 2026-11-25 faucet and explorer experience

**Facts reported** (maintainer, 2026-11-25):

- The Testnet faucet claim button was disabled.
- The miner and validator sponsor info showed "Unavailable".
- `/limits` was slow to load.
- An SS58 account search on FLOPScan failed.
- The intended on-chain action finally succeeded when submitted as a `utility.batchAll` extrinsic.

**Matching evidence:**

1. **The official UI's readiness logic.** The faucet page's inline script was decoded from the
   HTML served at [faucet.flop.network](https://faucet.flop.network/). [Verified 2026-11-25]
   - `available()` fetches `/chain` and `/limits` together. If either is non-2xx it throws, and the
     button stays disabled.
   - It then requires all of the following. If any is false, the button stays disabled.
     - `chain.network === "testnet"`.
     - `chain.genesisHash` equals the pinned genesis.
     - `limits.network === "testnet"`.
     - `limits.stale === false`.
     - `faucet.status === "open"`.
     - `agent.claimPath === "/v1/testnet/agent-claims"`, `grantFlop === 10` and
       `rolling24HourCapFlop === 10`.
   - `refresh()` first sets both sponsor cards to "Unavailable". It replaces that text only if
     `available()` gets past the network, genesis and `stale` checks. Then `open` and
     `automatic_full` get friendly labels, and other statuses are shown as raw text (such as
     "positions full" or "unknown").
   - The fetches have **no timeout**, and `refresh()` runs only on page load and after a submit.
     `/health` does not gate the button.
2. **`/chain` returned 503.** Testnet faucet `/chain` returned **HTTP 503**
   `{"error":"Faucet RPC did not verify the release genesis"}` after 2.75 s, at about 19:00:16Z.
   [Verified 2026-11-25] It recovered by about 19:08Z (10/10 requests returned 200).
   - In the same seconds (19:00:13.6–19:00:18.9Z), our own Testnet RPC call `chain_getBlockHash [0]`,
     the genesis lookup, took 5.3 s; no other Testnet RPC call in the run took more than 0.38 s
     (§10.1). [Verified 2026-11-25]
   - The faucet's genesis check probably timed out against a slow RPC. [Inference] We cannot tell
     whether the faucet uses the same RPC node.
   - On the UI, a single 503 like this disables the button and leaves both sponsor cards on
     "Unavailable". [Inference]
3. **The faucet backend lost its RPC connection.** During the same run, Testnet `/health` once
   reported `status: "disconnected"`, and `dependencies.signer.ok` flipped between `true` and
   `false`. [Verified 2026-11-25]
4. **`/limits` flapped.** Earlier the same day, Testnet `/limits` went from `faucet.status: "open"`
   to `"unknown"` (with `sponsor_unavailable`) between two reads about 66 s apart.
   [Verified 2026-11-25] This matches [#1353](https://github.com/flop-labs/network/issues/1353).
   During the 5-minute PoC run it stayed `open`.
5. **The indexer was unavailable.** Testnet `/health` reports
   `dependencies.indexer = {ok: false, reason: "indexer_unavailable"}`. Every FLOPScan Testnet API
   call (`/api/stats`, `/api/blocks`, `/api/search`) returned 503 `"Era-T reader unavailable"`.
   [Verified 2026-11-25] The search page goes through `/api/search`, so an SS58 search cannot
   succeed while that reader is down. [Inference]

**Assessment.** The observations are consistent with intermittent loss of the faucet backend's RPC
connection, which affected `/chain`, `/health` and `/limits`, plus a separate Testnet indexer
outage that affected the explorer and the faucet's `indexer` dependency. The UI never re-checks and
its fetches have no timeout, so one bad or slow read leaves the page stuck in the disabled state
until it is reloaded. [Inference]

**The root causes are unconfirmed.** FLOP Labs has published no incident note, and flop-watch
cannot see inside the faucet or the indexer.

## 8. Existing tools and overlap

Based on a GitHub search on 2026-11-25. Searches for "flop prometheus", "flop grafana", "flop
exporter", "flop uptime" and "flop status page" returned nothing relevant. [Verified 2026-11-25]

| Tool | What it measures | History | Live / hosted | Network |
|---|---|---|---|---|
| Official service `/health` (faucet, gateway, MCP, explorer) | Point-in-time dependency state | No | Yes | Devnet; Testnet faucet only |
| `@flop-labs/cli network status` | One-shot RPC/faucet identity and readiness | No | Local | Both |
| Hosted MCP (`flop_health`, `flop_get_stats`, `flop_get_block`) | Point-in-time stats (tools not exercised) | No | Yes | Devnet |
| FLOPScan / Devnet explorer | Current head, finality state, indexer view | No (current state only) | Yes | Both (Testnet down on 2026-11-25) |
| [coinisan/flop-health-monitor](https://github.com/coinisan/flop-health-monitor) | Polls faucet, explorer and gateway `/health` | Local JSONL | No (macOS launchd) | Devnet |
| [maho0638/reddragon-technocore](https://github.com/maho0638/reddragon-technocore) | `/api/flop-status` identity label | No | Yes | Point-in-time |
| [xbtMelchizedek/flopscan](https://github.com/xbtMelchizedek/flopscan) | Devnet accounting forensics | — | — | Devnet |
| [Defi76/flop-network-monitor](https://github.com/Defi76/flop-network-monitor), [lovelydisya17/flop-testnet-tracker](https://github.com/lovelydisya17/flop-testnet-tracker) | Trivial scripts | No | No | — |
| flopnetworknews.com tracker | Editorial JSON, updated by hand | Manual | Yes | — |
| **flop-watch (proposed)** | RPC WS/HTTP, heads, finality, block interval, faucet capacity, indexer | **Yes (Prometheus)** | **Yes + self-host** | **Both** |

None of these records a time series of RPC latency, WS vs HTTP availability, finality lag, block
interval or faucet capacity. [Verified 2026-11-25]

**Pain points** in [flop-labs/network](https://github.com/flop-labs/network/issues). All are
`status:triage`, with no maintainer reply on monitoring. [Verified 2026-11-25]

- [#369](https://github.com/flop-labs/network/issues/369): Devnet RPC 502/530 and WS 1006 while
  finality advances.
- [#381](https://github.com/flop-labs/network/issues/381): WS fails while HTTPS works.
- [#1283](https://github.com/flop-labs/network/issues/1283): finalized-head age averaging 9 s with
  60 s spikes.
- [#1335](https://github.com/flop-labs/network/issues/1335): grants delayed about 3.5 h while
  `/limits` said `open`.
- [#1353](https://github.com/flop-labs/network/issues/1353): `/limits` flaps to `unknown`.
- [#1364](https://github.com/flop-labs/network/issues/1364): `low_balance` with 10,812 pending.
- [#590](https://github.com/flop-labs/network/issues/590): a request for a published incident log.
- [#1289](https://github.com/flop-labs/network/issues/1289): explorer genesis block not found.

## 9. Technical limitations

- **Single vantage point.** Every measurement includes our network path and the Cloudflare edge.
  flop-watch cannot tell a regional outage from a global one. [Inference]
- **No node-internal metrics.** Node Prometheus (9615) and telemetry are not public, so peer counts
  describe only the RPC node that happened to answer.
  [Documented: [run-validator](https://docs.flop.network/docs/run-validator)]
- **Unpublished rate limits.**
  - The Devnet RPC is "rate-limited" with no numbers, and the RPC sent no rate-limit headers.
    [Documented; Verified 2026-11-25]
  - Only the Devnet explorer advertises a limit: `ratelimit-policy: 120;w=60`.
    [Verified 2026-11-25]
- **The public RPC is probably load-balanced.** Devnet WS head notifications skipped 53 blocks and
  rewound twice in 5 minutes. Finality lag went negative 24 times, down to −9, and the best head was
  once 10.3 s behind wall-clock. [Verified 2026-11-25] The likely cause is a backend mix or a
  lagging backend. [Inference] Therefore **notification arrival time is not block time.**
- **Undocumented explorer APIs.** `/api/stats` and `/api/health` are internal Next.js routes. They
  can change without notice, and Testnet has no `/api/health`. [Verified 2026-11-25]
- **Faucet schema churn.** The two faucets run different images: Testnet `/health` reports image
  `0.1.489`, Devnet `0.1.417`. [Verified 2026-11-25] Container images ship as frequent `0.1.4xx`
  releases. [Documented: [releases.json](https://flop.network/releases.json)] Parsers must tolerate
  missing and new fields.
- **Testnet reset risk.** "May restart or reset", with no announcement channel.
  [Documented: [Testnet](https://docs.flop.network/networks/testnet)]
- **Docs drift.** The documented client versions lag npm (§5), and the SDK profile lists a gateway
  host that does not resolve. [Verified 2026-11-25]

## 10. PoC results

All runs on 2026-11-25 between 19:00 and 19:05 UTC, with Node v24.11.0 and the three scripts running
concurrently. Raw data:

- [`heads-ws.json`](../poc/results/2026-11-25/heads-ws.json)
- [`rpc-http.json`](../poc/results/2026-11-25/rpc-http.json)
- [`services.json`](../poc/results/2026-11-25/services.json)
- [`services-testnet-recheck.json`](../poc/results/2026-11-25/services-testnet-recheck.json): one
  Testnet sample at 19:13Z (`node poc/services.mts --networks=testnet --samples=1`). In it,
  `/chain` returned 200 with a matching genesis, while `/health` and explorer `/stats` were still
  503.

### 10.1 `rpc-http.mts`: HTTP JSON-RPC

10 samples 3 s apart per network, plus one identity pass. [Verified 2026-11-25]

| | Devnet | Testnet |
|---|---|---|
| Requests / HTTP 200 / JSON-RPC errors | 34 / 34 / 0 | 34 / 34 / 0 |
| `chain_getHeader` p50 / p95 (ms) | 226 / 557 | 198 / 218 |
| `system_health` p50 / p95 (ms) | 223 / 505 | 197 / 211 |
| `chain_getFinalizedHead` p50 / p95 (ms) | 214 / 549 | 199 / 209 |
| `chain_getBlockHash [0]` (ms, n = 1) | 361 | **5308** |
| `genesisMatch` | true | true |
| `specName` / `specVersion` | `tzkv-runtime` / 1014034 | `flop-testnet` / 1014035 |
| `slotDurationMs` / `epochLength` | 1000 / 3600 | 1000 / 3600 |
| Peers / `isSyncing` | 26 / {false, **true**} | 17 / {false} |
| Best head advance | 0.999 blocks/s | 0.999 blocks/s |
| Rate-limit headers | none | none |

Two transient effects stand out: the single 5.3 s `chain_getBlockHash [0]` on Testnet, which
coincided with the faucet `/chain` 503 (§7), and Devnet reporting `isSyncing: true` once. Only
continuous recording can put effects like these into context.

### 10.2 `heads-ws.mts`: WebSocket heads

300 s per network, one connection, no reconnect. [Verified 2026-11-25]

To check parent links, the probe computes each block hash itself as blake2b-256 of the SCALE-encoded
header. The `headerHashSelfCheck` field confirms that this reproduces the node's finalized-head hash
on both networks.

| | Devnet | Testnet |
|---|---|---|
| Connect (ms) / subscriptions accepted | 517 / 3 of 3 | 485 / 3 of 3 |
| Close events | only our own (1000) | only our own (1000) |
| Head notifications / blocks advanced | 250 / 300 | 303 / 297 |
| Skipped blocks / rewinds / duplicate heights | **53** / 2 / 2 | 0 / 2 / 1 |
| Head arrival interval p50 / p95 / max (ms) | 1080 / 2561 / **7434** | 1000 / 1442 / 1614 |
| Slot interval (consecutive, parent-linked), n / min / max | 237 / 1000 / 1000 ms | 300 / 1000 / 1000 ms |
| Parent-link mismatches / undecoded headers | 0 / 0 | 0 / 0 |
| `slotSanityMaxSkewSec` (best head vs wall-clock) | 10.3 | 1.4 |
| Finality lag (blocks) min / p50 / max | **−9** / 2 / 4 | 3 / 4 / 5 |
| Negative-lag observations | 24 of 242 | 0 of 288 |
| Finalized slot age (s) p50 / max | 5.2 / 10.5 | 4.9 / 6.4 |
| Finalized notifications skipping blocks | 58 blocks | 10 blocks |
| Runtime version pushed | 1014034 | 1014035 |
| BABE variants (1 Primary / 3 SecondaryVRF) | 6 / 244 | 7 / 296 |

Findings:

- **Block production was perfectly regular.** Every slot in the 5 minutes produced a block on both
  networks: the slot delta was exactly 1000 ms every time. A block-interval metric therefore mostly
  reads 1 s. Its value is in catching empty slots and stalls. [Verified 2026-11-25; Inference]
- **Devnet delivery is irregular.** Devnet's WS delivery (skips, rewinds, negative lag, a 10 s stale
  head) has nothing to do with block production. This confirms that notification timing must not be
  reported as block interval. [Inference]
- **Earlier 60 s run.** The run during planning, earlier the same day, saw Devnet head gaps up to
  29 s and finality lag down to −36. The variance on Devnet is large. [Verified 2026-11-25]
- **Rewinds happen on both networks.** They are consistent with short BABE forks: the next header
  links to the new branch, and no parent-link mismatch was seen. [Inference]

### 10.3 `services.mts`: faucet and explorer

10 samples 30 s apart per network; `/chain` fetched once. [Verified 2026-11-25]

| | Devnet | Testnet |
|---|---|---|
| `/limits` HTTP / p50 / p95 (ms) | 200 ×10 / 588 / 615 | 200 ×10 / 266 / 325 |
| `/limits` `asOf` age (s) min / p50 / max | 58 / 136 / 289 | 24 / 144 / **324** |
| `stale` / `faucet.status` | false / open | false / open |
| Sponsor miner / validator | `positions_full` / `open` | `open` / `automatic_full` |
| `pendingGrants` | 0–1 | 0 |
| `/health` HTTP / `status` / `ready` | 200 / degraded / false | **503** / degraded, **disconnected** / false |
| `/health` dependencies not ok | `funding` (`ok: false`, no reason) | `indexer` (`indexer_unavailable`); `signer` flipped false once |
| `/health` `retry-after` | — | `60` |
| `/chain` | 200, genesis match | **503** "Faucet RPC did not verify the release genesis" (2.75 s) |
| Explorer `/stats` | 200 ×10, p50 564 ms; `finality.state` normal; `finalizedLag` 4–5 | **503 ×10** "Era-T reader unavailable" |
| Explorer rate-limit headers | `ratelimit-policy: 120;w=60` | none |

Findings:

- **`asOf` lags.** `asOf` was up to 5.4 min old even though we read every 30 s, while llms.txt says
  `/limits` is "refreshed about once a minute". [Verified 2026-11-25;
  Documented: [llms.txt](https://flop.network/llms.txt)]
- **`/health ready` is per-client.** It was `false` on **both** networks while `/limits` said
  `open`. The body scopes it to "this client" (`readinessScope`). It is not a global claim-readiness
  signal. [Verified 2026-11-25]
- **Testnet `/stats` is down.** The explorer schema below comes from the Devnet sample and the
  FLOPScan bundle, where the Testnet UI calls the same routes with a 12 s timeout and polls `/stats`
  every 5 s. [Verified 2026-11-25]
  - Fields: `latestBlockNumber`, `avgBlockTime` (ms), `tps`, `activeValidators`,
    `registeredMiners`, …
  - `finality{bestBlock, finalizedBlock, finalizedLag, state, safeMode, thresholds}`
  - `consensus{state, peers, isSyncing, headAgeSeconds}`
  - `liveStatsAgeSeconds`
- **One indexer behind both Devnet services.** The Devnet faucet `/health` indexer binding and the
  explorer writer share `dataGeneration` `83e802ce-…`. [Verified 2026-11-25]

### 10.4 Fallback outcomes

| Fallback trigger | Outcome |
|---|---|
| Subscriptions refused, or WS closed with 1008/1013/429 | **Not hit.** All six subscriptions were accepted, and there were no remote closes. The WS design stands. |
| `slotSanityMaxSkewSec > 120` or `undecodedHeaders > 0` | **Not hit.** Skew was 10.3 s / 1.4 s, with 0 undecoded headers. The block-interval metric from slot deltas stands. |
| Testnet genesis ≠ pinned value | **Not hit.** It matched over RPC; the faucet matched on the rechecks. |
| Testnet explorer `/stats` 503 for the whole run | **Hit.** The schema is documented from the Devnet sample and the bundle; the probe stays best-effort. |
| New `faucet.status` or sponsor status values | **None new.** `/health.status` showed `disconnected`, which is not exported as an enum (architecture.md §6). |

## 11. Challenges to the original idea

- **The SDK is rejected for the collector.** [Decision]
  - It adds about 300 MB RSS and 116 packages.
  - It needs a full metadata initialisation on every connect.
  - It throws `RUNTIME_INCOMPATIBLE` on any unlisted `specVersion`, so the collector would break at
    exactly the event it should report.
  - The collector needs only 4 RPC reads and 3 subscriptions, plus under 200 lines of decoding
    (SCALE compact, BABE pre-digest, BLAKE2b-256 header hash). The PoC shows these work without
    dependencies.
- **Inference and gateway monitoring is deferred.** [Decision] It needs an API key and spends
  broker quota, and there is no Testnet gateway. Keyless gateway and MCP `/health` checks are the
  first post-MVP candidate.
- **The account-lookup pain is an explorer/indexer outage.** flop-watch can *detect* it (explorer
  probe down, faucet `indexer` dependency not ok) but cannot fix it or replace the explorer.
  [Inference]
- **The value is history and correct interpretation, not feature count.** The official surfaces
  already answer "is it up now?". What is missing is "since when, how often, and is it the chain or
  the service?". [Inference]

## 12. Unresolved questions

- **RPC.** What are the numeric rate limits of the Devnet and Testnet RPCs? Is the public RPC
  load-balanced across several nodes, as the Devnet skips and negative lag suggest?
- **Faucet enums.** What is the full set of `faucet.status` values? What exactly does
  `pendingGrants` count (queued, unsigned or unfinalized grants)?
- **Resets.** How will Testnet resets be signalled, if at all?
- **Explorer.** What does the Testnet explorer `/api/stats` schema look like when the "Era-T reader"
  is healthy?
- **Testnet `/chain` 503.** What triggers "Faucet RPC did not verify the release genesis", and how
  often does it happen?
- **Welcome.** Would FLOP Labs welcome an independent public monitor, or prefer a different
  endpoint or cadence?
- **Grafana hardening.** The exact anonymous-access settings for the public dashboard are to be
  confirmed in M3 against the pinned Grafana version.
