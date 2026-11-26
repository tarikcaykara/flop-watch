# CLAUDE.md — flop-watch

Independent, read-only observability for FLOP Network Devnet and Testnet. It covers RPC health,
genesis identity, best and finalized head, block interval, finality lag, and faucet and indexer
status, with history in Prometheus and display in Grafana. It is a single maintainer project, so
keep everything boring and small (KISS/YAGNI).

Everything in the repo is English: code, comments, docs, commits, issues and PRs.

## Read first

- `docs/architecture.md`: read it before any change to collection, metrics, rules, dashboards or
  deployment. When a decision changes, update it in the same PR.
- `docs/research.md`: the verified facts about FLOP endpoints, with their evidence tags.
- `docs/dashboard.md`: the panel spec of the Grafana dashboard. Read it before changing rules or the
  dashboard; a panel change updates it in the same PR.
- `docs/mvp.md`: what is in and out of scope, the acceptance criteria and the roadmap.
- `poc/`: the frozen research probes and their recorded results. These are the reference fixtures
  for parsers and decoders. Do not edit them; copy what you need into `test/fixtures/`.

## Hard rules

1. **Read-only.** No keys, no signing, no POST/PUT/DELETE to the faucet, gateway or explorer.
   Faucet and explorer probes are GETs on fixed paths. No claim or write path (`agent-claims`,
   `/fund`, `/sponsor`, `faucet/fund`, gateway `enroll` or `chat/completions`) ever appears in
   `src/`.
2. **RPC allowlist.** Every JSON-RPC call, over HTTP or WS, goes through the method allowlist in
   `src/rpc-http.ts` (architecture §11). Any other method throws before a request is sent.
3. **Remote data never crashes the process.** Parsers are tolerant. A missing or retyped field
   skips its metric and increments `flopwatch_schema_mismatch_total`. Unknown enum values map to
   `other`.
4. **Bounded labels.** Only the labels of architecture §6. Never use block hashes (other than the
   genesis hash), addresses or error text as a label value.
5. **Derived lives in rules.** The collector exports only measured and reported values.
   Interpretation (lags, ages, readiness, incidents) lives in `prometheus/rules/`. Every panel and
   alert states whether its signal is measured, reported or derived.
6. **Traffic budget.** Steady state is ≤ 0.25 requests/s per network. Changing a cadence means
   updating the budget table in architecture §4 in the same PR.
7. **One runtime dependency:** `@prometheus-io/client` (the official successor of the deprecated
   `prom-client`). Adding another runtime dependency needs the owner's approval.
8. **Nothing private in the repo.** No hostnames, servers or tunnels of the public instance, and
   no personal data.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node 24 LTS, running `.ts` directly through type stripping (no build step, no `dist/`) |
| Language | TypeScript strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties) |
| Package manager | pnpm 10 |
| Metrics | `@prometheus-io/client` (only runtime dependency) |
| Transport | Global `fetch` and `WebSocket`, raw JSON-RPC 2.0 |
| HTTP server | `node:http` |
| Tests | `node:test`, offline, with recorded fixtures; `ws` (dev only) as the fake RPC node; timers injected, never mocked globally |
| Lint / format | Biome |
| Stack | Prometheus + Grafana, Docker Compose |

These deviate from the owner's default stack (Bun, Zod, Hono, SQLite) on purpose; see
architecture §2 and §12. Not used: `@flop-labs/sdk`, `@polkadot/api`, Alertmanager.

## Commands

The scripts exist from #1 on:

```bash
pnpm install
pnpm check        # biome ci .
pnpm typecheck    # tsc --noEmit
pnpm test         # node --test
pnpm audit:deps   # pnpm audit --audit-level=moderate, from #24
node src/main.ts  # collector, from #4
pnpm test:e2e     # the Compose stack e2e; needs Docker, from #12
pnpm test:rules   # promtool check and test of prometheus/; needs Docker, from #13
```

The gate is `pnpm check && pnpm typecheck && pnpm test && pnpm audit:deps`. Run it before every
push; CI runs the same, with the audit last. Run `pnpm test:rules` and `pnpm test:e2e` too before
pushing a change to the Dockerfile, `compose.yaml`, `prometheus/` or `grafana/`; CI runs them from
#15 and #38.

## Workflow

- Never ask for, store or handle credentials.
- **Never commit to `main`.** Each issue goes branch `<type>/<issue>-<slug>` → PR → reviewer-agent
  pass → green CI → squash merge, with the PR title as the commit subject. One issue = one PR.
- **Order.** Work follows the issues' "Depends on" order within the current milestone. The owner
  can reorder at any time.
- **Tests first.** Every issue that changes behaviour starts with its tests:
  1. Write the tests from the issue's acceptance and run them. They must fail on their
     assertions, because the behaviour or a deliverable file is missing (a series is absent;
     `.env.example` does not exist). A load error of code (an import of a missing module or
     export) or a type error does not count: for new code, the test commit adds the smallest
     stub that compiles, and expected lists are literals in the test.
  2. Commit them alone as `test(<scope>): …`; the message says what fails and why, and the squash
     body keeps it on `main`.
  3. Implement in a separate commit until they pass; refactor with them green.
  4. A test added later, for example after the review, says so in the PR body.

  Push once, after the implementation: the test commit alone is red by design, and the gate runs
  on the branch tip. Docs-only, CI-only, dependency-bump and behaviour-preserving changes have
  nothing to fail and skip this; their PR body says "Not applicable". Otherwise the PR body's
  **Tests first** section names the test commit and the failure it showed before the change.
  PRs #36 and #39 are the reference examples.
- **Test layers.** Pick the lowest layer that proves the acceptance:
  - unit and integration (`pnpm test`, offline; `test/*.test.ts`): parsers, decoders, config,
    probes and the chain watcher against local fake servers, and a process test of the real
    collector;
  - rules (`pnpm test:rules`; `prometheus/tests/*.yml`): recording rules and alerts;
  - stack e2e (`pnpm test:e2e`, Docker; `test/e2e/*.e2e.ts`): the Compose stack, Prometheus and
    Grafana, with no FLOP host contacted.
- **Reviewer-agent pass.** Before a PR is merged or handed to the owner, an agent that did not
  write the change reviews its diff. Fix or answer every finding, and summarise the review in the
  PR body.
- **Merging.** Claude merges a PR once the review is done and CI is green, **except** owner-review
  PRs.
- **Owner-review PRs.** These are PRs that touch any of the following:
  - the RPC method allowlist or the code that enforces it (hard rule 2);
  - any outbound URL path, HTTP method or new remote host (hard rule 1);
  - Grafana authentication or authorization settings, or anything published beyond
    `127.0.0.1`;
  - a new runtime dependency, or any major version update;
  - a Dependabot PR in the `runtime` group (any production dependency; today only
    `@prometheus-io/client`, which is still 0.x);
  - the licence, the hard rules or this list.

  Such a PR's body opens with `Owner review: <item>`. Claude stops once CI is green and the review
  is done, tells the owner, and the owner reviews and merges.
- **Dependabot.** `.github/dependabot.yml` opens monthly update PRs after a 7-day cooldown;
  security updates come at once. Each PR gets the reviewer-agent pass, which reads the changelogs
  between the two versions, and a green gate. Claude merges the `tooling` and `actions` groups; the
  owner merges the `runtime` group and every major. Nothing auto-merges.
- **Dependency audit.** A moderate or higher advisory turns the gate red, so every PR is red
  until it is triaged; this is deliberate. While the repo is idle, Dependabot alerts report new
  advisories. Fix an advisory with an update through a PR. Only when no fixed version fits and the
  vulnerable code is unreachable in flop-watch may it be ignored, through pnpm's
  `auditConfig.ignoreGhsas` setting, with the owner's approval and the reason in that PR.
- **After a merge.** GitHub deletes the remote branch. Switch to `main`, `git pull --ff-only`, and
  delete the local branch with `git branch -D`.
- **Commits.** Conventional Commits, imperative mood, no `Co-Authored-By` trailers.
- **Docs.** Update `README.md`, `CLAUDE.md` and `docs/` in the same PR as any behaviour change.
