# Security policy

## Reporting a vulnerability in flop-watch

Please report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/tarikcaykara/flop-watch/security/advisories/new).
Do not open a public issue.

In scope:

- the collector (`src/`);
- the Compose stack and its Prometheus and Grafana configuration;
- anything that could make flop-watch send a non-read request to FLOP Network, or expose more
  than the read-only dashboard.

You will get an answer within a week. Fixes go through a private security advisory and a release.

## Vulnerabilities in FLOP Network itself

flop-watch only observes FLOP Network from the outside. Report issues in FLOP's nodes, RPC,
faucet, explorer or gateway to FLOP Labs (`security@flop.finance`, as listed in
<https://flop.network/llms.txt>), not here.
