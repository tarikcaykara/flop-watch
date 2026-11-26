# flop-watch — dashboard spec

Status: proposal, pending owner approval (#33). This is the panel spec of the `flop-watch-overview`
dashboard of [architecture.md](architecture.md) §8. #14 builds the dashboard from it, and #13
builds the rules it reads (architecture §7).

## 1. Purpose

The dashboard answers three questions, in this order (mvp.md §2):

1. **Is it me or them, right now?** A Testnet participant opens it before retrying a claim or
   filing an issue.
2. **Since when, and how often?** This is the history that FLOP's point-in-time `/health`
   endpoints do not keep.
3. **Is it the chain or a service?** RPC, finality, faucet and explorer sit side by side, each
   labelled measured, reported or derived.

Every panel serves one of these questions. Identity details and the collector's own metrics are
in collapsed rows at the bottom.

## 2. Dashboard settings

| Setting | Value | Reason |
|---|---|---|
| UID, title | `flop-watch-overview`, `FLOP Network health — flop-watch` | A stable link for issues and posts |
| Variable `network` | `label_values(flopwatch_probe_total, network)`, single-select, no "All", default `testnet` | Networks are never mixed in a panel (architecture §8) |
| Default time range | Last 24 h | One day shows "since when" for most incidents and keeps the default load small for anonymous viewers |
| Refresh | 1 min; the shortest choice is 30 s | The probes run every 30–60 s and Prometheus scrapes every 15 s |
| Timezone | UTC | Issues in flop-labs/network report times in UTC |
| Tooltip | Shared crosshair | Compare rows at the same moment |
| Annotation | `ALERTS{alertname="FlopRuntimeUpgraded", alertstate="firing", network="$network"}`, titled "Runtime upgrade" | Runtime upgrades on every time-series panel (architecture §8) |

## 3. Conventions

- **Descriptions.** Each panel's description starts with its category and source, in the form
  `Measured · <source>.`, then says in one sentence what to read from it, and any caveat. The
  descriptions below are the final texts. Titles stay short; the About panel explains the
  categories once.
- **Colours.** Green is healthy, orange is degraded or a warning threshold, red is down or a
  critical threshold. Blue and grey are neutral information, such as the per-client `ready` flag.
- **Missing data.** A value series disappears when its source fails (architecture §5). Panels show
  it as "No data" in grey, never as 0. Time series do not connect points across gaps longer than
  2 min, so an outage stays visible as a gap.
- **Thresholds** use the same numbers as the alerts of architecture §7. The yellowpaper thresholds
  (30 and 120 blocks) are named as such in the description; the others are proposed defaults.
- **Negative values.** Lags are shown raw, with a line at 0. They can go negative on Devnet
  (research.md §10.2) and against the explorer.
- **Units.** Seconds `s`; blocks `none` with the suffix ` blocks`; FLOP `none` with the suffix
  ` FLOP`; requests per second `reqps`. Block numbers show all digits, without SI prefixes.
- **Rates** use `$__rate_interval`.
- **State sets.** `flopwatch_faucet_status` and `flopwatch_faucet_sponsor_status` are turned into
  one code per series by the panel query, and value mappings show the state's name. This only
  encodes the display; it interprets nothing.

  ```promql
  # Faucet status code: 1 open, 2 low_balance, 3 unknown, 4 other
      sum(flopwatch_faucet_status{network="$network", status="open"})
  + 2 * sum(flopwatch_faucet_status{network="$network", status="low_balance"})
  + 3 * sum(flopwatch_faucet_status{network="$network", status="unknown"})
  + 4 * sum(flopwatch_faucet_status{network="$network", status="other"})
  ```

  ```promql
  # Sponsor lane code: 1 open, 2 automatic_full, 3 positions_full, 4 unknown, 5 other
      sum by (lane) (flopwatch_faucet_sponsor_status{network="$network", status="open"})
  + 2 * sum by (lane) (flopwatch_faucet_sponsor_status{network="$network", status="automatic_full"})
  + 3 * sum by (lane) (flopwatch_faucet_sponsor_status{network="$network", status="positions_full"})
  + 4 * sum by (lane) (flopwatch_faucet_sponsor_status{network="$network", status="unknown"})
  + 5 * sum by (lane) (flopwatch_faucet_sponsor_status{network="$network", status="other"})
  ```

- **Mobile.** Grafana stacks panels in row order on a narrow screen, so a phone shows the "Now"
  row first. #14 checks the dashboard on a phone before it merges.

## 4. Layout

Grafana's grid is 24 columns wide; sizes are width × height in grid units.

| Row | State | Panels |
|---|---|---|
| (top) | — | About (24×3) |
| Now | open | 8 stats (3×4 each) |
| Incidents | open | Incidents (24×8); Firing now (12×6), Last successful probe (12×6) |
| RPC | open | Availability (12×6), Latency (12×6); Failures (8×6), WebSocket reconnects (8×6), Node peers and syncing (8×6) |
| Blocks and finality | open | Heads now (24×3); Finality lag (12×7), Head age (12×7); Block interval (12×7), Skipped and rewound heads (12×7) |
| Faucet | open | Claims ready (12×5), Faucet probes (12×5); Status (12×5), Sponsor lanes (12×5); Balance (8×6), Daily cap (8×6), Pending grants (8×6); `/health` (12×5), Dependencies (12×5); Indexer lag (8×6), `/limits` data age (8×6), Response time (8×6) |
| Explorer | open | Explorer probe (8×6), Indexer lag (8×6), Finality view (8×6) |
| Identity | collapsed | Chain identity (12×5), Genesis match (12×5); Runtime version (12×5), Slot duration (12×5) |
| Collector | collapsed | Version (6×4), Requests to FLOP (9×6), Memory (9×6); Schema mismatches (24×6) |

## 5. Panels

### About

- **A1 About** · text, 24×3
  - Content (Markdown): "Independent, read-only monitor of FLOP Network Devnet and Testnet,
    from a single vantage point. Not affiliated with FLOP Labs. **Measured**: observed by
    flop-watch. **Reported**: stated by a FLOP node or service. **Derived**: computed by a rule
    from other signals. Times are UTC. Source and method:
    [github.com/tarikcaykara/flop-watch](https://github.com/tarikcaykara/flop-watch)."

### Now

Each stat shows the latest value of the selected network.

- **N1 RPC WebSocket** · stat
  - Query: `flopwatch_probe_success{network="$network", target="rpc_ws"}`
  - Display: 1 "Up" green, 0 "Down" red.
  - Description: "Measured · `system_health` over flop-watch's RPC WebSocket, every 30 s. Down
    means the last health call over the WebSocket failed."
- **N2 RPC HTTP** · stat
  - Query: `flopwatch_probe_success{network="$network", target="rpc_http"}`
  - Display: 1 "Up" green, 0 "Down" red.
  - Description: "Measured · `chain_getHeader` and `system_health` over HTTP JSON-RPC, every
    30 s. Down means at least one of the two failed in the last cycle."
- **N3 Best head age** · stat
  - Query: `flopwatch:best_head_age_seconds{network="$network"}`
  - Display: s; green below 10, orange from 10, red from 30 (`FlopBestHeadStale`).
  - Description: "Derived · time since flop-watch received the last new-head notification over
    the WebSocket. Blocks come every second, so over 30 s means no new block reached us."
- **N4 Finality lag** · stat
  - Query: `flopwatch:finality_lag_blocks{network="$network"}`
  - Display: blocks; green below 30, orange from 30, red from 120.
  - Description: "Derived · best minus finalized block number, from the WebSocket subscriptions.
    30 and 120 blocks are the yellowpaper's warning and freeze thresholds."
- **N5 Faucet claims** · stat
  - Query: `flopwatch:faucet_claim_ready{network="$network"}`
  - Display: 1 "Ready" green, 0 "Not ready" red.
  - Description: "Derived · mirrors the official faucet page's check: `/chain` and `/limits`
    fetched, the faucet's genesis matches, `stale` is false and the status is `open`. Not ready
    means the claim button would be disabled."
- **N6 Faucet status** · stat
  - Query: the faucet status code of §3.
  - Display: 1 "open" green, 2 "low_balance" red, 3 "unknown" orange, 4 "other" grey.
  - Description: "Reported · `faucet.status` from the faucet's `/limits`, every 60 s."
- **N7 Explorer** · stat
  - Query: `flopwatch_probe_success{network="$network", target="explorer_stats"}`
  - Display: 1 "Up" green, 0 "Down" red.
  - Description: "Measured · GET `/api/stats` on the explorer, every 60 s. Down means the
    request failed or did not return a JSON object."
- **N8 Genesis** · stat
  - Query: `min(flopwatch_genesis_match{network="$network"})`
  - Display: 1 "Match" green, 0 "Mismatch" red.
  - Description: "Reported · the genesis hash from the RPC WebSocket, RPC HTTP and the faucet,
    against the pinned one. A mismatch points to a network reset or an endpoint serving another
    chain; the Identity row shows which source."

### Incidents

- **I1 Incidents** · state timeline, 24×8
  - Query:

    ```promql
        3 * max by (alertname) (ALERTS{alertstate="firing", severity="critical", network=~"$network|"})
    or  2 * max by (alertname) (ALERTS{alertstate="firing", severity="warning", network=~"$network|"})
    or      max by (alertname) (ALERTS{alertstate="firing", severity="info", network=~"$network|"})
    ```

  - Display: one row per alert, legend `{{alertname}}`; 3 "critical" red, 2 "warning" orange,
    1 "info" blue. An empty stretch means the alert was not firing. `network=~"$network|"` keeps
    `FlopWatchDown`, which has no network label.
  - Description: "Derived · Prometheus alert rules over flop-watch's signals. Each alert's
    category (measured, reported, derived) is in the Firing now table."
- **I2 Firing now** · table, 12×6
  - Query (instant): `ALERTS{alertstate="firing", network=~"$network|"}`
  - Display: columns `alertname`, `severity`, `category`; no value or time column.
  - Description: "Derived · the alerts firing now, with the category of the signal each one
    reads."
- **I3 Last successful probe** · table, 12×6
  - Query (instant): `flopwatch_probe_last_success_timestamp_seconds{network="$network"} * 1000`
  - Display: columns `target` and the value, unit "From Now" (milliseconds, so the query multiplies
    by 1000).
  - Description: "Measured · when each probe last succeeded. A target missing here has not
    succeeded since the collector started."

### RPC

- **R1 RPC availability** · state timeline, 12×6
  - Queries: `flopwatch_ws_connected{network="$network"}` as "WebSocket connected";
    `flopwatch_probe_success{network="$network", target="rpc_ws"}` as "WebSocket probe";
    `flopwatch_probe_success{network="$network", target="rpc_http"}` as "HTTP probe".
  - Display: 1 "Up" green, 0 "Down" red.
  - Description: "Measured · flop-watch's WebSocket connection and its 30 s probes over the
    WebSocket and HTTP. Gaps mean the collector was not running."
- **R2 RPC latency** · time series, 12×6
  - Queries:
    `histogram_quantile(0.5, sum by (le, target) (rate(flopwatch_probe_duration_seconds_bucket{network="$network", target=~"rpc_ws|rpc_http"}[$__rate_interval])))`
    as `{{target}} p50`, and the same with `0.95` as `{{target}} p95`.
  - Display: s.
  - Description: "Measured · response time of the RPC probes from one vantage point, including
    our network path and the Cloudflare edge. HTTP includes the genesis check every 10 min."
- **R3 RPC failures** · time series as bars, 8×6
  - Query:
    `sum by (target, result) (increase(flopwatch_probe_total{network="$network", target=~"rpc_ws|rpc_http", result!="ok"}[$__rate_interval]))`
    as `{{target}} {{result}}`.
  - Display: stacked bars.
  - Description: "Measured · failed RPC requests by result: timeout, network error, HTTP error,
    JSON-RPC error, invalid response or rate limited."
- **R4 WebSocket reconnects** · time series as bars, 8×6
  - Queries:
    `sum by (reason) (increase(flopwatch_ws_disconnects_total{network="$network"}[$__rate_interval]))`
    as `disconnect: {{reason}}`;
    `increase(flopwatch_ws_connects_total{network="$network"}[$__rate_interval])` as `connect`.
  - Display: stacked bars.
  - Description: "Measured · WebSocket connections opened, and closed by reason: a remote close,
    an error, or flop-watch's stall watchdog (no new head for 30 s)."
- **R5 Node peers and syncing** · time series, 8×6
  - Queries: `flopwatch_rpc_node_peers{network="$network"}` as `peers ({{transport}})`;
    `flopwatch_rpc_node_is_syncing{network="$network"}` as `syncing ({{transport}})`, as bars on
    the right axis (0 or 1).
  - Description: "Reported · peers and the syncing flag from `system_health`, of whichever RPC node
    behind the load balancer answered. This describes that node, not the network."

### Blocks and finality

- **B1 Heads now** · stat, 24×3
  - Queries: `flopwatch_chain_best_block_number{network="$network"}` as "Best (WebSocket)";
    `flopwatch_chain_finalized_block_number{network="$network"}` as "Finalized (WebSocket)";
    `flopwatch_rpc_http_best_block_number{network="$network"}` as "Best (HTTP)";
    `flopwatch_explorer_latest_block_number{network="$network"}` as "Explorer latest".
  - Display: unit `none`, no decimals.
  - Description: "Reported · the latest block numbers from the WebSocket subscriptions,
    `chain_getHeader` over HTTP and the explorer's `/api/stats`."
- **B2 Finality lag** · time series, 12×7
  - Query: `flopwatch:finality_lag_blocks{network="$network"}`
  - Display: blocks; threshold lines at 30 orange and 120 red; a line at 0.
  - Description: "Derived · best minus finalized block number. 30 and 120 blocks are the
    yellowpaper's warning and freeze thresholds. Devnet can go negative, because its WebSocket
    streams come from more than one backend."
- **B3 Head age** · time series, 12×7
  - Queries: `flopwatch:best_head_age_seconds{network="$network"}` as "best";
    `flopwatch:finalized_head_age_seconds{network="$network"}` as "finalized".
  - Display: s; threshold lines at 30 orange (`FlopBestHeadStale`) and 120 red
    (`FlopFinalityStalled`).
  - Description: "Derived · time since the last new-head and finalized-head notifications
    reached flop-watch. This reflects delivery to us, not block production."
- **B4 Block interval** · heatmap, 12×7
  - Query:
    `sum by (le) (increase(flopwatch_chain_block_interval_seconds_bucket{network="$network"}[$__rate_interval]))`,
    format heatmap.
  - Display: y axis in s, from the histogram buckets.
  - Description: "Reported · BABE slot delta times slot duration, between consecutive,
    parent-linked blocks. 1 s is normal; anything higher means empty slots."
- **B5 Skipped and rewound heads** · time series as bars, 12×7
  - Queries:
    `increase(flopwatch_ws_head_skipped_blocks_total{network="$network"}[$__rate_interval])` as
    "skipped blocks";
    `increase(flopwatch_ws_head_rewinds_total{network="$network"}[$__rate_interval])` as
    "rewinds".
  - Description: "Measured · blocks the new-head subscription skipped, and notifications at or
    below the previous height. This is about delivery to us, not about block production."

### Faucet

- **F1 Claims ready** · state timeline, 12×5
  - Query: `flopwatch:faucet_claim_ready{network="$network"}`
  - Display: 1 "Ready" green, 0 "Not ready" red.
  - Description: "Derived · mirrors the official faucet page's check: `/chain` and `/limits`
    fetched, the faucet's genesis matches, `stale` is false and the status is `open`. The page's
    agent-lane constants are not checked."
- **F2 Faucet probes** · state timeline, 12×5
  - Query: `flopwatch_probe_success{network="$network", target=~"faucet_.*"}` as `{{target}}`.
  - Display: 1 "Up" green, 0 "Down" red.
  - Description: "Measured · GET `/limits`, `/health` and `/chain` every 60 s. `/health` counts as
    up on its 503 'degraded' answer too, because that is a valid answer."
- **F3 Status** · state timeline, 12×5
  - Queries: the faucet status code of §3 as "status";
    `flopwatch_faucet_stale{network="$network"}` as "stale".
  - Display: status as in N6; stale 0 "fresh" green, 1 "stale" red.
  - Description: "Reported · `faucet.status` and `stale` from `/limits`."
- **F4 Sponsor lanes** · state timeline, 12×5
  - Query: the sponsor lane code of §3, as `{{lane}}`.
  - Display: 1 "open" green, 2 "automatic_full" blue, 3 "positions_full" orange, 4 "unknown" red,
    5 "other" grey.
  - Description: "Reported · `sponsor.miner.status` and `sponsor.validator.status` from `/limits`.
    The official page shows 'Unavailable' for both when its own check fails."
- **F5 Balance** · time series, 8×6
  - Queries: `flopwatch_faucet_balance_flop{network="$network"}` as "balance";
    `flopwatch_faucet_min_balance_flop{network="$network"}` as "minimum", dashed.
  - Display: FLOP.
  - Description: "Reported · the faucet's balance and its minimum balance, from `/limits`."
- **F6 Daily cap** · time series, 8×6
  - Queries: `flopwatch_faucet_daily_cap_used_flop{network="$network"}` as "used";
    `flopwatch_faucet_daily_cap_limit_flop{network="$network"}` as "limit", dashed;
    `flopwatch_faucet_daily_cap_remaining_flop{network="$network"}` as "remaining".
  - Display: FLOP.
  - Description: "Reported · the faucet's daily cap: used, limit and remaining, from `/limits`."
- **F7 Pending grants** · time series, 8×6
  - Query: `flopwatch_faucet_pending_grants{network="$network"}`
  - Description: "Reported · `faucet.pendingGrants` from `/limits`. A rising count means grants are
    queued and not yet paid out."
- **F8 `/health`** · state timeline, 12×5
  - Queries: `flopwatch_faucet_health_http_status_code{network="$network"}` as "HTTP status";
    `flopwatch_faucet_health_ready{network="$network"}` as "ready (this client)".
  - Display: status 200–299 green, 503 "503 degraded" orange, any other value red; ready 1
    "ready" blue, 0 "not ready" grey.
  - Description: "Measured (HTTP status) and reported (ready) · GET `/health`. The faucet scopes
    `ready` to the client asking, here flop-watch's own address, so it is not global claim
    readiness; see Claims ready."
- **F9 Dependencies** · state timeline, 12×5
  - Query: `flopwatch_faucet_dependency_ok{network="$network"}` as `{{dependency}}`.
  - Display: 1 "ok" green, 0 "not ok" red.
  - Description: "Reported · `dependencies.<name>.ok` from `/health`. A dependency without an `ok`
    field, such as `signing`, has no row."
- **F10 Indexer lag (faucet)** · time series, 8×6
  - Query: `flopwatch_faucet_indexer_lag_blocks{network="$network"}`
  - Display: blocks.
  - Description: "Reported · `dependencies.indexer.details.lagBlocks` from `/health`: how far the
    faucet's indexer is behind its chain head."
- **F11 `/limits` data age** · time series, 8×6
  - Query: `flopwatch:faucet_limits_age_seconds{network="$network"}`
  - Display: s; threshold line at 300 orange (`FlopFaucetLimitsStale`).
  - Description: "Derived · time since the `asOf` of the last `/limits` answer. It swings between
    about 0.4 and 5.4 min in normal operation; the alert fires only when it stays over 5 min for
    5 min."
- **F12 Response time** · time series, 8×6
  - Query:
    `histogram_quantile(0.95, sum by (le, target) (rate(flopwatch_probe_duration_seconds_bucket{network="$network", target=~"faucet_.*"}[$__rate_interval])))`
    as `{{target}} p95`.
  - Display: s.
  - Description: "Measured · p95 response time of the faucet probes from one vantage point."

### Explorer

- **E1 Explorer probe** · state timeline, 8×6
  - Query: `flopwatch_probe_success{network="$network", target="explorer_stats"}`
  - Display: 1 "Up" green, 0 "Down" red.
  - Description: "Measured · GET `/api/stats` every 60 s, best effort, because the API is
    undocumented."
- **E2 Indexer lag (explorer)** · time series, 8×6
  - Query: `flopwatch:explorer_indexer_lag_blocks{network="$network"}`
  - Display: blocks; threshold line at 120 orange; a line at 0.
  - Description: "Derived · our best block minus the explorer's latest indexed block. It can be
    slightly negative when the explorer's node is ahead of the WebSocket backend we hear from."
- **E3 Finality view (explorer)** · time series, 8×6
  - Queries: `flopwatch_explorer_finalized_lag_blocks{network="$network"}` as "finalized lag";
    `flopwatch_explorer_safe_mode{network="$network"}` as "safe mode", as bars on the right axis
    (0 or 1).
  - Display: blocks.
  - Description: "Reported · the explorer's own finality lag and `safeMode` flag from
    `/api/stats`. The explorer reports its own thresholds as 30 (warn) and 120 (freeze) blocks."

### Identity (collapsed)

- **D1 Chain identity** · table, 12×5
  - Query (instant): `flopwatch_chain_info{network="$network"}`
  - Display: columns `chain`, `spec_name`, `genesis_hash`.
  - Description: "Reported · `system_chain`, `state_getRuntimeVersion` and
    `chain_getBlockHash [0]` over the WebSocket, read on every connect."
- **D2 Genesis match** · state timeline, 12×5
  - Query: `flopwatch_genesis_match{network="$network"}` as `{{source}}`.
  - Display: 1 "match" green, 0 "mismatch" red.
  - Description: "Reported · whether each source's genesis hash equals the pinned one: the RPC
    WebSocket, RPC HTTP (every 10 min) and the faucet's `/chain` (every 60 s)."
- **D3 Runtime version** · time series, stepped, 12×5
  - Query: `flopwatch_runtime_spec_version{network="$network"}`
  - Display: unit `none`, no decimals.
  - Description: "Reported · the runtime `specVersion` from the runtime-version subscription.
    Each step is a runtime upgrade, also marked as an annotation."
- **D4 Slot duration** · stat, 12×5
  - Query: `flopwatch_chain_slot_duration_seconds{network="$network"}`
  - Display: s.
  - Description: "Reported · BABE slot duration from `BabeApi_configuration`."

### Collector (collapsed)

- **C1 Version** · stat, 6×4
  - Query: `flopwatch_build_info`, display name `${__field.labels.version}`.
  - Description: "Self · the running flop-watch version."
- **C2 Requests to FLOP** · time series, 9×6
  - Query: `sum(rate(flopwatch_probe_total{network="$network"}[10m]))`
  - Display: reqps; threshold line at 0.25 red.
  - Description: "Self · flop-watch's steady-state requests to this network's endpoints, against
    the 0.25 requests/s budget. Reconnect identity calls are not counted."
- **C3 Memory** · time series, 9×6
  - Query: `process_resident_memory_bytes{job="flop-watch"}`
  - Display: bytes; threshold line at 150 MB orange.
  - Description: "Self · the collector's resident memory. The MVP target is under 150 MB."
- **C4 Schema mismatches** · table, 24×6
  - Query (instant):
    `sum by (target, field) (increase(flopwatch_schema_mismatch_total{network="$network"}[$__range])) > 0`
  - Display: columns `target`, `field` and the count.
  - Description: "Self · remote fields that were missing or had an unexpected type in the selected
    time range. A FLOP service probably changed its JSON."

## 6. Coverage

Every metric family of architecture §6 appears in a panel, directly or through a rule:

| Metric family | Panels |
|---|---|
| `flopwatch_probe_success` | N1, N2, N7, R1, F2, E1 |
| `flopwatch_probe_duration_seconds` | R2, F12 |
| `flopwatch_probe_total` | R3, C2 |
| `flopwatch_probe_last_success_timestamp_seconds` | I3 |
| `flopwatch_ws_connected`, `_connects_total`, `_disconnects_total` | R1, R4 |
| `flopwatch_chain_best_block_number`, `_finalized_block_number` | B1; B2, N4 (rule) |
| `flopwatch_chain_*_head_received_timestamp_seconds` | B3, N3 (rules) |
| `flopwatch_ws_head_skipped_blocks_total`, `_rewinds_total` | B5 |
| `flopwatch_chain_block_interval_seconds`, `_slot_duration_seconds` | B4, D4 |
| `flopwatch_chain_info`, `flopwatch_runtime_spec_version`, `flopwatch_genesis_match` | D1, D3, D2, N8 |
| `flopwatch_rpc_node_peers`, `_is_syncing`, `flopwatch_rpc_http_best_block_number` | R5, B1 |
| `flopwatch_faucet_status`, `_stale`, `_sponsor_status` | N6, F3, F4 |
| `flopwatch_faucet_limits_as_of_timestamp_seconds` | F11 (rule) |
| `flopwatch_faucet_balance_flop`, `_min_balance_flop` | F5 |
| `flopwatch_faucet_daily_cap_*_flop`, `_pending_grants` | F6, F7 |
| `flopwatch_faucet_health_ready`, `_health_http_status_code`, `_dependency_ok`, `_indexer_lag_blocks` | F8, F9, F10 |
| `flopwatch_explorer_latest_block_number`, `_finalized_lag_blocks`, `_safe_mode` | B1, E2 (rule), E3 |
| `flopwatch_build_info`, `flopwatch_schema_mismatch_total` | C1, C4 |
| Default process metrics | C3 (resident memory only; the rest are not shown) |

## 7. Rules and alerts the dashboard needs

- **Recording rules.** The panels read the six recording rules of architecture §7 and no others:
  `flopwatch:finality_lag_blocks`, `flopwatch:best_head_age_seconds`,
  `flopwatch:finalized_head_age_seconds`, `flopwatch:faucet_limits_age_seconds`,
  `flopwatch:faucet_claim_ready` and `flopwatch:explorer_indexer_lag_blocks`.
- **`category` is an alert label.** I1 and I2 read alerts from the `ALERTS` series, which carries
  an alert's labels but not its annotations. Each alert therefore has a `category` label next to
  `severity`; its values are `measured`, `reported` and `derived`.
- **The explorer alert is split in two.** `FlopExplorerIndexerLagging` used to fire both when the
  explorer was down and when it lagged. A down explorer is measured, a lag is derived, and the
  Testnet explorer was down for whole days. Two alerts keep the incident timeline readable:
  - `FlopExplorerDown`: `flopwatch_probe_success{target="explorer_stats"} == 0` for 5m, warning,
    measured;
  - `FlopExplorerIndexerLagging`: `flopwatch:explorer_indexer_lag_blocks > 120` for 5m, warning,
    derived.

## 8. Decisions for the owner

Each choice below is already applied in this spec; the owner confirms or changes it.

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| 1 | Row order | Now and Incidents first, then RPC, Blocks, Faucet, Explorer; Identity and Collector collapsed at the bottom | Architecture §8's original order: Identity first, Incidents last |
| 2 | About panel | A slim text panel at the top: what this is, not affiliated, the three categories | No text; categories only in descriptions |
| 3 | Defaults | Last 24 h, refresh 1 min, UTC | Last 6 h; browser timezone |
| 4 | Explorer alert | Split into `FlopExplorerDown` and `FlopExplorerIndexerLagging` (§7) | One alert, as in architecture §7 today |
| 5 | `category` | A label on every alert (§7) | An annotation, which Grafana cannot show from `ALERTS` |
| 6 | `/health` `ready` | Neutral blue and grey, labelled "this client"; no alert | Green and red like the other flags |
| 7 | Missing data | "No data" in grey, gaps over 2 min left open | Show 0, or connect across gaps |
