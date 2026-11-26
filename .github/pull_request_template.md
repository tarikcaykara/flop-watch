<!--
Owner-review PRs (CLAUDE.md › Workflow) start with one line before everything else:
Owner review: <item from the list>
-->

Closes #

**What**
-

**Tests first**
<!-- CLAUDE.md › Workflow › Tests first. Docs-only or CI-only: say "Not applicable" and why. -->
- Test commit: `<sha>`; before the change it failed with: …
- Implementation: `<sha>`; the tests pass.
- Tests added later (for example after the review): `<sha>`, and why.

**Checks**
- `pnpm check && pnpm typecheck && pnpm test && pnpm audit:deps` green locally.

**Review**
- Pending.
