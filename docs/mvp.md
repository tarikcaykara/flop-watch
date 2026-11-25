# flop-watch — MVP definition

Status: proposal, pending approval. Research date: 2026-11-25. Evidence and sources are in
[research.md](research.md); the design is in [architecture.md](architecture.md). Tags follow the
convention in research.md §1.

## 1. Problem statement

FLOP Network's public infrastructure reports **point-in-time** health only. Each service has a
`/health` endpoint, the CLI has a one-shot `network status` check, and the explorer shows the
current head. Nobody records what happened over time. [Verified 2026-11-25]

So when something fails, a Testnet participant cannot tell whether the cause is on their side, in
the RPC, the indexer, the faucet backend or the chain itself, or whether it has happened before.
The public issue tracker shows that this happens often. All of these are open with `status:triage`
and no maintainer reply on monitoring (research.md §8):

- Devnet RPC 502/530 and WS 1006 while finality advances:
  [flop-labs/network#369](https://github.com/flop-labs/network/issues/369).
- WS fails while HTTPS works: [#381](https://github.com/flop-labs/network/issues/381).
- Finalized-head age averaging 9 s with 60 s spikes:
  [#1283](https://github.com/flop-labs/network/issues/1283).
- Grants delayed about 3.5 h while `/limits` said `open`:
  [#1335](https://github.com/flop-labs/network/issues/1335).
- `/limits` flapping to `unknown`: [#1353](https://github.com/flop-labs/network/issues/1353).
- Faucet `low_balance` with 10,812 pending grants:
  [#1364](https://github.com/flop-labs/network/issues/1364).
- A request for a published incident log: [#590](https://github.com/flop-labs/network/issues/590).

There is no independent history of RPC availability, finality lag, block cadence or faucet
capacity. [Verified 2026-11-25: GitHub search, research.md §8]

## 2. Target audience

In priority order:

1. **Testnet participants and agents.** They use the public dashboard to check "is it me or is it
   them?" before retrying a claim or filing an issue.
2. **Developers integrating FLOP RPC.** They need to know how reliable the WS and HTTP endpoints are,
   how fast they respond, and how finality behaves.
3. **Node and infrastructure operators.** They self-host the Compose package and can point it at
   their own endpoints.

## 3. Value proposition

flop-watch is the only independent view of FLOP RPC, finality and faucet/indexer health that is
recorded continuously from the outside. Every signal is labelled as **measured** (by flop-watch),
**reported** (by a FLOP service) or **derived** (inferred by a rule). Readers can see what is a
fact and what is an interpretation. [Decision]

## 4. Essential MVP features

Exactly the scope of [architecture.md](architecture.md) §4–8, for **Devnet and Testnet**:

- **Collector** (§4): one persistent WS per network (heads, finalized heads, runtime version), HTTP
  RPC probes, faucet `/limits`, `/health` and `/chain`, and explorer `/api/stats`.
- **Metrics** (§6): the `flopwatch_*` families listed there, each with its category.
- **Rules** (§7): the recording rules and alerts shown in Grafana as derived incidents.
- **Dashboard** (§8): `flop-watch-overview`, with a network selector.
- **Self-host package**: `compose.yaml` with the collector, Prometheus and Grafana, plus
  `.env.example`.
- **Public instance**: the same Compose stack on the maintainer's server, with Grafana published
  read-only.

## 5. Explicitly excluded

- Account balance or nonce inspection.
- Miner and validator analytics.
- Gateway inference latency and settlement monitoring. This needs an API key, spends broker quota,
  and there is no Testnet gateway.
- Gateway and MCP `/health`, and keyless `/v1/models` counts. These are deferred as the **first
  post-MVP candidate**.
- Notifications and Alertmanager (user decision: derived incidents only).
- A custom status-page frontend.
- Multi-region probes.
- Historical backfill.
- Mainnet, which is not live.
- Any faucet claim or other write action.

## 6. Acceptance criteria

Each criterion is testable:

1. With both networks reachable, all MVP metric families appear with `network` ∈ {`devnet`,
   `testnet`} within 2 min of `docker compose up`.
2. Setting `FLOPWATCH_TESTNET_EXPECTED_GENESIS` to a wrong hash makes
   `flopwatch_genesis_match{network="testnet"}` = 0, and `FlopGenesisMismatch` fires within 1 min.
3. An unreachable RPC URL for one network gives probe success 0 and visible WS backoff in the logs.
   The process does not crash, and the other network's metrics are unaffected.
4. A fixture `/limits` with `faucet.status: "unknown"` gives `flopwatch:faucet_claim_ready` = 0.
5. Steady-state outbound requests are ≤ 0.25/s per network. This is measured as
   `sum by (network) (rate(flopwatch_probe_total[10m]))` plus the WS health pings.
6. `count({__name__=~"flopwatch_.*"})` < 1000.
7. Collector RSS < 150 MB after 24 h.
8. A unit test proves that the RPC method allowlist rejects `author_submitExtrinsic`.
9. `grep` finds no faucet claim paths in `src/`.
10. A fresh clone plus `cp .env.example .env && docker compose up -d` gives a working dashboard at
    `http://127.0.0.1:3000` with no manual steps.
11. CI runs `tsc --noEmit`, `biome ci`, `node --test`, `promtool check rules` and `docker build`.

## 7. Roadmap

Milestones become GitHub milestones once the repo is public. One issue is one PR, on a branch named
`<type>/<issue>-<slug>`.

| Milestone | Content |
|---|---|
| M0 | Research: this phase (PoCs, research, architecture, MVP). |
| M1 | Repo publication. Collector core: config, `rpc-http`, `chain-watcher`, `babe`, metrics server, tests. Licence chosen at publication (proposal: Apache-2.0, the same as flop-labs/network). |
| M2 | Service probes (faucet, explorer). Tolerant parsers with fixtures taken from `poc/results`. |
| M3 | Stack: Dockerfile, Compose, Prometheus rules, Grafana provisioning and dashboard, CI. |
| M4 | Public instance, README self-host guide, v0.1.0 release. |

## 8. Dependencies and blockers

- **Stable public endpoints and schemas.** The faucet and explorer JSON shapes are undocumented and
  change with image releases.
- **Unpublished rate limits.** The Devnet RPC is "rate-limited" with no numbers published. The
  collector's budget is designed to stay far below any plausible limit.
- **Testnet reset risk.** The docs say the Testnet "may restart or reset". flop-watch detects this
  through the genesis hash but cannot predict it.
- **A host for the public instance.** This is the maintainer's existing server. The hostname and
  tunnel are decided at M4, outside the repo.
- **No official contact.** There is no acknowledgement from FLOP Labs. An optional courtesy issue in
  flop-labs/network can follow M4.

## 9. Go / no-go recommendation

**Go, with this narrowed MVP.** [Decision] The PoC did not hit the "subscriptions refused" fallback
(research.md §10.4). The steady-state budget is about 0.17 requests/s per network, which is under
the 0.25 requests/s limit (architecture.md §4).

Abandon or pivot if any of these happens:

- FLOP publishes an official status page with history that covers RPC, finality and the faucet.
- The public RPCs block or throttle read-only monitoring.
- Testnet ends with no successor network.

Honest framing: the audience is small (Testnet participants, integrators, a few operators). The
project's value is ecosystem credibility and a public portfolio piece. It does **not** make anyone
eligible for an airdrop, and it earns no vouchers.

## 10. Future opportunities

- Gateway and MCP `/health`, and keyless model counts (first post-MVP candidate).
- Per-authority block production, as a bounded top-N to keep cardinality fixed.
- Grafana annotations for runtime upgrades.
- A probe from a second vantage point.
- An account inspector, if participants need one more than they need the explorer.
