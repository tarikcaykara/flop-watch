# flop-watch

Independent, read-only observability for [FLOP Network](https://flop.network) Devnet and Testnet.

FLOP's public services report health only at a single point in time. flop-watch records it
continuously, from the outside:

- RPC availability and latency over WebSocket and HTTP;
- genesis and runtime identity;
- best and finalized head, finality lag and block interval;
- faucet capacity and readiness;
- the explorer's indexer state.

It keeps the history in Prometheus and shows it in Grafana. Every signal is labelled as
**measured** (by flop-watch), **reported** (by a FLOP service) or **derived** (by a rule).

> **Status: pre-alpha.** Research is done (M0). The collector is being built (M1). There is nothing
> to run yet beyond the research probes. See the
> [milestones](https://github.com/tarikcaykara/flop-watch/milestones).

flop-watch is a community project. It is not affiliated with or endorsed by FLOP Labs.

## Documents

- [Research](docs/research.md): verified endpoints, PoC results, existing tools and limitations.
- [Architecture](docs/architecture.md): collector, metrics, rules, dashboard and deployment design.
- [MVP](docs/mvp.md): scope, acceptance criteria, roadmap and go/no-go.

## Research probes

The proof-of-concept probes in [`poc/`](poc/) need only Node 24 or later. Nothing to install:

```bash
node poc/rpc-http.mts > rpc-http.json    # HTTP JSON-RPC latency, identity, BABE config (~35 s)
node poc/heads-ws.mts > heads-ws.json    # WebSocket heads, slots, finality lag (300 s)
node poc/services.mts > services.json    # faucet and explorer endpoints (~5 min)
```

The probes are read-only: JSON-RPC reads and HTTP GETs only. The results recorded on 2026-11-25 are
in [`poc/results/`](poc/results/).

## Licence

[Apache-2.0](LICENSE)
