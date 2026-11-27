# flop-watch

Independent, read-only observability for [FLOP Network](https://flop.network) Devnet and Testnet.

FLOP's public services report health only at a single point in time. flop-watch records it
continuously, from the outside:

- RPC availability and latency over WebSocket and HTTP;
- genesis and runtime identity;
- best and finalized head, finality lag and block interval;
- faucet capacity and readiness;
- the explorer's indexer state.

It keeps the history in Prometheus and shows it in Grafana. Every signal about FLOP is labelled as
**measured** (by flop-watch), **reported** (by a FLOP service) or **derived** (by a rule).

> **Status: pre-alpha.** The collector, the Prometheus rules and the Grafana dashboard run as one
> Docker Compose stack, which you can host yourself with the guide below. A public instance and the
> v0.1.0 release come next. See the
> [milestones](https://github.com/tarikcaykara/flop-watch/milestones).

flop-watch is a community project. It is not affiliated with or endorsed by FLOP Labs.

## Quick start

You need Git, and Docker Engine 25 or later with Docker Compose 2.24 or later. The stack contacts
only the public FLOP endpoints, over HTTPS and WSS.

```bash
git clone https://github.com/tarikcaykara/flop-watch.git
cd flop-watch
cp .env.example .env            # then set GRAFANA_ADMIN_PASSWORD in .env
docker compose up -d --wait     # returns once all three services are healthy
```

`.env.example` ships the placeholder `change-me` as the password: replace it before the first
start.

Open <http://127.0.0.1:3000>. The dashboard, "FLOP Network health — flop-watch", is the home page.
It opens without a login and is read-only. Pick the network at the top; Testnet is the default.

The first values show within about a minute. The history starts when you start the stack:
flop-watch has nothing from before.

To manage Grafana itself (users, settings), sign in as `admin` with the password from `.env`.
Grafana reads that password only when it creates its database, on the first start. After that,
change it in Grafana. The dashboard stays read-only even for `admin`: it is generated from
`grafana/dashboard.ts` (`pnpm dashboard`).

### Stopping, updating and removing

```bash
docker compose down                       # stop; the history stays in Docker volumes
git pull && docker compose up -d --build --force-recreate --wait   # update
docker compose down --volumes             # stop and delete the history and Grafana's database
```

An update recreates every container, so Prometheus loads the new rules and Grafana the new
provisioning; Prometheus does not reload its rules on its own. The history survives it.

Prometheus keeps 180 days of history.

### What is published

Only Grafana is published, and only on `127.0.0.1`. The collector and Prometheus are reachable
only inside the Compose network.

To make the dashboard public, put your own reverse proxy or tunnel in front of Grafana, set a
strong admin password first, and set `GRAFANA_ROOT_URL` to the public address. Anonymous visitors
get the Viewer role. Viewers can still send their own PromQL queries through Grafana and create
short URLs; the [security notes](docs/architecture.md#11-security) explain why this is accepted
and how to limit it.

## Configuration

Everything is set in `.env`. `.env.example` lists every variable, commented out at its default.
After a change, run `docker compose up -d` again.

| Variable | Default | Meaning |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | none, required | Grafana's admin password, read on the first start only |
| `GRAFANA_PORT` | `3000` | Port of Grafana on `127.0.0.1` |
| `GRAFANA_ROOT_URL` | `http://127.0.0.1:<GRAFANA_PORT>/` | The address visitors open Grafana at; behind a reverse proxy or tunnel, its public URL |
| `COLLECTOR_VERSION` | `local` | Tag of the collector image that `docker compose` builds and runs, `flop-watch:<COLLECTOR_VERSION>` |
| `FLOPWATCH_NETWORKS` | `devnet,testnet` | The networks to watch |
| `FLOPWATCH_<NET>_RPC_WS` | the network's public RPC | WebSocket RPC URL (`ws://` or `wss://`) |
| `FLOPWATCH_<NET>_RPC_HTTP` | the network's public RPC | HTTP RPC URL (`http://` or `https://`) |
| `FLOPWATCH_<NET>_FAUCET_URL` | the network's public faucet | Faucet base URL; empty turns the faucet probes off |
| `FLOPWATCH_<NET>_EXPLORER_API_URL` | the network's explorer API | Explorer API base URL; empty turns the explorer probe off |
| `FLOPWATCH_<NET>_EXPECTED_GENESIS` | the network's genesis hash | The genesis hash every source is checked against |
| `FLOPWATCH_HOST` | `0.0.0.0` | The collector's listen address; keep `0.0.0.0` in Docker, so Prometheus reaches it |
| `FLOPWATCH_PORT` | `10063` | The collector's metrics port |
| `FLOPWATCH_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

`<NET>` is `DEVNET` or `TESTNET`. The defaults are in `.env.example`.

- **Your own node.** Point `FLOPWATCH_<NET>_RPC_WS` and `_RPC_HTTP` at it, for example
  `ws://my-node:9944` and `http://my-node:9944`. The collector runs in a container, so
  `localhost` there is the container itself, not your machine.
- **One network.** `FLOPWATCH_NETWORKS=testnet`.
- **Empty values.** An empty value means "use the default", except for the faucet and explorer
  URLs, where it turns that probe off.
- **The metrics port.** A changed `FLOPWATCH_PORT` needs the same change in
  `prometheus/prometheus.yml`.
- **Checked at start.** The collector refuses to start on a mistake and lists every problem at
  once: an unknown `FLOPWATCH_*` name (a typo, for example), a malformed URL or genesis hash, or
  two networks with the same endpoint or genesis.

## What the signals mean

Each panel's description starts with its category:

- **Measured:** flop-watch observed it itself, such as whether a request succeeded and how long it
  took.
- **Reported:** a FLOP node or service said so, such as the block number or the faucet's status.
  flop-watch passes it on unchanged.
- **Derived:** a Prometheus rule computed it from other signals, such as the finality lag or an
  incident.
- **Self:** about flop-watch itself.

| Signal | Category | Source | How to read it |
|---|---|---|---|
| RPC probes: up or down, latency, failures by kind | measured | `system_health` over the WebSocket every 30 s; `chain_getHeader` and `system_health` over HTTP every 30 s | Whether the public RPC answered flop-watch, and how fast. The time includes the network path and the Cloudflare edge |
| WebSocket connection and reconnects | measured | flop-watch's own connection | A reconnect after 30 s without a new head counts as a stall |
| Best and finalized block number | reported | The WebSocket head subscriptions | The node's view of the chain |
| Head arrival times, skipped and rewound heads | measured | When the notifications reached flop-watch | Arrival time is not block time: the public RPC mixes backends |
| Block interval | reported | The BABE slots of two linked consecutive heads, times the slot duration | Blocks come every second; a longer interval means missed slots |
| Chain identity, runtime version, genesis match | reported | `system_chain`, `state_getRuntimeVersion`, and the genesis hash from the WebSocket, HTTP and the faucet's `/chain` | A genesis mismatch points to a network reset or an endpoint that serves another chain |
| Node peers and syncing | reported | `system_health` | Describes the RPC node that answered, not the whole network |
| Faucet status, balance, daily cap, pending grants, sponsor lanes | reported | The faucet's `/limits`, every 60 s | What the faucet says about its capacity |
| Faucet `/health`: `ready`, dependencies, indexer lag | reported | The faucet's `/health`, every 60 s | `ready` is for flop-watch's own address, not for every user. A 503 is the faucet's normal "degraded" answer, so the probe still succeeds |
| Explorer latest block, finalized lag, safe mode | reported | The explorer's `/api/stats`, every 60 s | Best effort: the API is undocumented |
| Finality lag, head ages, `/limits` age, explorer indexer lag | derived | Recording rules | Lags are shown raw and can go negative on Devnet |
| Faucet claims ready | derived | Recording rule | Mirrors the official Testnet faucet page's check: `/chain` and `/limits` answered, the genesis matches, the data is not stale and the status is `open` |
| Incidents | derived | 14 alert rules | Shown on the dashboard only; flop-watch sends no notifications |
| Collector version, requests to FLOP, memory, schema mismatches | self | The collector | A schema mismatch means a FLOP service changed a field that flop-watch reads |

The incidents, with their thresholds:

| Alert | Fires when |
|---|---|
| `FlopRpcWsDown`, `FlopRpcHttpDown` | The RPC probe has failed for 2 min |
| `FlopGenesisMismatch` | Any source reports a genesis other than the expected one |
| `FlopBestHeadStale` | No new head for over 30 s, for 1 min |
| `FlopFinalityLagging` | Finality is over 30 blocks behind, for 2 min |
| `FlopFinalityStalled` | Finality is over 120 blocks behind, or no finalized head for over 120 s, for 1 min |
| `FlopRuntimeUpgraded` | The runtime version changed in the last 15 min |
| `FlopFaucetUnreachable` | `/limits` has failed for 5 min |
| `FlopFaucetClaimsNotReady` | Faucet claims have not been ready for 5 min |
| `FlopFaucetLowBalance` | The faucet has reported `low_balance` for 5 min |
| `FlopFaucetLimitsStale` | The `/limits` data has been over 5 min old for 5 min |
| `FlopExplorerDown` | `/api/stats` has failed for 5 min |
| `FlopExplorerIndexerLagging` | The explorer is over 120 blocks behind the chain, for 5 min |
| `FlopWatchDown` | Prometheus has not reached the collector for 2 min |

The rules file, `prometheus/rules/flop-watch.rules.yml`, is the source of these conditions. 30 and
120 blocks are the FLOP yellowpaper's finality thresholds. The other thresholds and
durations are proposed defaults. The [dashboard spec](docs/dashboard.md) describes every panel,
and [architecture §6–§7](docs/architecture.md#6-prometheus-metric-design) every metric and rule.

## Traffic

Per network, in steady state, flop-watch sends about 0.17 requests per second, about 600 per hour.
Its own limit is 0.25 per second.

| Calls | Every | Requests/s |
|---|---|---|
| `system_health` over the WebSocket | 30 s | 0.033 |
| `chain_getHeader` and `system_health` over HTTP | 30 s | 0.067 |
| The genesis hash over HTTP | 10 min | 0.002 |
| Faucet `/limits`, `/health` and `/chain` | 60 s | 0.050 |
| Explorer `/api/stats` | 60 s | 0.017 |

- **Not counted:** the head notifications that the WebSocket pushes.
- **Reconnects:** a reconnect adds 4 calls and 3 subscriptions. The backoff starts at 1 s and
  doubles up to 60 s.
- **Rate limits:** a failed request with `Retry-After` pauses the probes of that endpoint until
  then, for at most 10 min. The faucet's `/health` 503 is its normal answer and pauses nothing.
- **Read-only:** only JSON-RPC methods on a fixed read-only list, and HTTP GETs. Every request
  sends `User-Agent: flop-watch/<version> (+https://github.com/tarikcaykara/flop-watch)`.

## Limitations

- **One vantage point.** Every measurement includes flop-watch's own network path and the
  Cloudflare edge. It cannot tell a regional outage from a global one.
- **A load-balanced RPC.** The public RPC serves heads from several backends. Skipped or rewound
  heads and a negative finality lag can come from the RPC rather than the chain.
- **No node internals.** Node metrics and telemetry are not public. Peer counts describe only the
  RPC node that answered.
- **Undocumented APIs.** The explorer's `/api/stats` and the faucet's JSON are not documented and
  change with new releases. A missing or changed field drops its series and counts as a schema
  mismatch; it is never shown as a wrong value.
- **Claims ready is not a promise.** It mirrors the faucet page's own check. Eligibility,
  cooldowns and sponsor capacity are checked only when you claim.
- **Testnet resets.** The Testnet "may restart or reset" without notice. A reset shows as a
  genesis mismatch.
- **No notifications.** Incidents show on the dashboard; nothing is sent by e-mail or chat.

## Troubleshooting

`docker compose ps` shows each service's health, and `docker compose logs flop-watch` shows the
collector's log: JSON lines, except a configuration error, which is plain text.

- **`set GRAFANA_ADMIN_PASSWORD in .env`.** `docker compose up` needs `.env` with a password:
  `cp .env.example .env`, then set it.
- **Port 3000 is already in use.** Set `GRAFANA_PORT` in `.env`, for example `GRAFANA_PORT=3001`.
- **A new password in `.env` changes nothing.** Grafana reads it only on the first start. Change
  it in Grafana, or reset it:
  `docker compose exec grafana grafana cli admin reset-admin-password <new password>`.
- **The collector keeps restarting.** Its log starts with `Invalid configuration` and lists every
  problem in `.env`. Fix them and run `docker compose up -d`.
- **"No data" on every panel.** Check that `flop-watch` is `healthy` in `docker compose ps`. After
  changing `FLOPWATCH_PORT`, also change the target in `prometheus/prometheus.yml`.
- **One probe is down.** "Last successful probe" on the dashboard shows when each one last
  worked. The collector's warnings name the failing request and its result, such as `timeout`,
  `http_error` or `rate_limited`.
- **`FlopGenesisMismatch` on Testnet.** Either the Testnet was reset, or an endpoint serves
  another chain. If the [FLOP docs](https://docs.flop.network/networks/testnet) confirm a reset,
  set `FLOPWATCH_TESTNET_EXPECTED_GENESIS` to the new hash, and please open an issue so the
  default can follow.
- **Explorer down on Testnet with a 503 `Era-T reader unavailable`.** The explorer itself answers
  this; it was seen while FLOP's indexer was unavailable.

## Documents

- [Research](docs/research.md): verified endpoints, PoC results, existing tools and limitations.
- [Architecture](docs/architecture.md): collector, metrics, rules, dashboard and deployment design.
- [Dashboard](docs/dashboard.md): the Grafana panel spec, with each panel's question and query.
- [MVP](docs/mvp.md): scope, acceptance criteria, roadmap and go/no-go.

## Running the collector without Docker

You need Node 24 or later and pnpm 10:

```bash
pnpm install --prod
node src/main.ts                          # metrics on http://0.0.0.0:10063/metrics
FLOPWATCH_NETWORKS=testnet node src/main.ts
```

It reads the same `FLOPWATCH_*` variables from its environment, not from `.env`.

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
