---
title: "Tenvyr M10 Implementation Report: Operator Workbench"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/EXECUTION_STATUS.md
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/VERIFY.md
---

# M10 Operator Workbench — implementation report

Provisional implementer report. Sol audits closure; this document cannot
write `PASS`, `SAFE TO CLOSE`, or `CLOSED`.

## Implemented

- **Bounded read projections** (`WorkbenchProjectionService` +
  `WorkbenchController`): connection cards (status/reason/tested version/
  bounded capabilities; credential refs never exposed), paginated
  execution summaries with coordination phase + iteration, and the full
  execution projection (bounded goal preview with truncation, coordination
  run/iterations/worker statuses/decision, bounded attempt summaries —
  never raw snapshots/results/chain-of-thought, approval counts, bounded
  artifact references, delegation counts, declared bounds). Every response
  has stable ids, a server timestamp, bounds, and truncation metadata;
  cache/polling/browser storage never decide authority.
- **Idempotent command surface** (`WorkbenchCommandService` +
  `WorkbenchCommandsController`): start-team-run, resolve-wait, cancel,
  replay, compare — all through EXISTING authority services with durable
  operator-action audit evidence (`operator_actions`, migration
  `1722270016000-MilestoneTenOperatorActions`, UNIQUE (action,
  idempotencyKey)). Exactly-once: the audit row is inserted FIRST, a
  concurrent duplicate blocks on the unique index and returns the stored
  outcome WITHOUT re-executing authority. The UI never dispatches a
  Worker, applies a PlanPatch, advances an iteration, or marks completion.
- **Accessible Workbench shell** (`GET /workbench` on the gateway,
  self-contained HTML): connections, launch form with VISIBLE hard limits,
  live loop (phase, iteration N of max, workers, decision, budget,
  deadline), WAIT approve/deny, cancel, replay, inspection (artifact
  references, delegation, Capsule summary, compare, audit trail), bounded
  3s polling, labels/tables/aria/status-as-text, viewport-safe.
- **Deterministic offline demo** (`m10-demo.spec.ts`): the whole wedge —
  launch → Worker failure (evidence) → WAIT → operator approval → ACCEPT →
  Capsule — through the real command surface and engine/inbox machinery.
  Demo guide updated (`docs/showcase/demo-guide.md`).
- **Design-partner evidence:** 0 interviews this cycle; the discovery
  record states that no program is promoted without real evidence
  (`PRODUCT_DISCOVERY.md` M10 evidence record).

## Product outcome

A single trusted local operator can, from the Workbench page: see
connection cards, launch a supervised team run with explicit limits, watch
Planner/Workers/Verifier and the current iteration with remaining
deadline, approve or deny WAIT requests, cancel or replay, inspect
artifacts/delegation/Capsule/compare/audit, and reach a terminal outcome —
without service calls or database knowledge. Refresh/reconnect
reconstructs the same view; duplicate clicks are idempotent; terminal
state never regresses.

## Architectural decisions and deviations permitted by SPEC

- No frontend framework added: the Workbench is a self-contained page
  served by the gateway (no new dependency, no build step beyond the
  existing `nest build` + one asset copy).
- The recorded accessibility gate is the gateway page spec (labels,
  tables, aria, status-as-text, no remote scripts/eval) — the VERIFY's
  `pnpm --filter frontend test:safe-preview` gate exists and passed
  (2/2); the Workbench page has its own smaller gate in the gateway spec.
- Showcase gates run for real: `showcase:up`/`showcase:smoke` PASS
  (offline showcase: python/http → typescript/kafka → java runner +
  retry-once). The gates exposed and fixed four production boot bugs
  (missing RuntimeCoordinationService provider, SupervisionConfigService
  DI default-param, missing @Inject("DATA_SOURCE") on the new services,
  gateway dist asset copy).

## Verification evidence

- Orchestrator unit: 661 passed; gateway 4/4; frontend safe-preview 2/2,
  lint clean, typecheck clean.
- Real-PostgreSQL suite: 956 passed, run twice sequentially (includes
  M10-S1 projections, M10-S2 command idempotency/races/audit, M10-S4
  inspection, and the M10-S5 offline demo).
- `pnpm test:all` and `pnpm build:all` fully green.
- `pnpm showcase:up` + `pnpm showcase:smoke` PASS; `showcase:down` done.
- `pnpm test:docs` 20/20; `pnpm verify:docs` passed (119 files, 227
  links, 60 current, 42 capabilities); `pnpm test:identity` 25/25;
  `pnpm verify:identity` passed; `git diff --check` clean.

## Limitations

- M10 is `READY FOR INDEPENDENT SOL VERIFICATION`; M8/M9 Sol reviews are
  still pending at owner direction (recorded in EXECUTION_STATUS).
- External Production Exposure Gate remains OPEN: the Workbench surface is
  loopback/private trusted-operator only and displays that limitation.
- Design-partner interviews: 0 — no wedge completion evidence from real
  users; nothing is promoted from technical enthusiasm.
- Large-run browser checks beyond the projection caps were not run in a
  real browser; the bounded caps are unit- and integration-tested.

## Closure hardening (2026-08-14, implementer)

- Runtime Connection operations (create / revise / test / revoke) are now
  audited, idempotent Workbench commands. The operator-action evidence row
  and the authority mutation commit in ONE transaction (manager-aware
  service variants `createConnectionWithManager` /
  `reviseConnectionWithManager` / `revokeConnectionWithManager`).
- Revision idempotency: the same key + same payload retried (concurrently
  or sequentially) produces exactly one new revision; the same key with a
  conflicting payload is rejected with `IDEMPOTENCY_CONFLICT` (canonical
  payload hash comparison on every duplicate delivery).
- Revoke idempotency: repeated identical revoke commands produce one
  effective authority transition with one durable evidence row.
- Test-connection evidence: bounded secret-free receipts only; probe
  output and credentials never enter audit payloads.
- Surface routing: `connections.controller` mutations go through the
  command layer; the gateway proxies and the Workbench page send
  idempotency keys on every connection mutation. No un-audited mutation
  path is reachable from the Workbench surface.
- Real-PostgreSQL regressions: concurrent duplicate revise (6-way, one
  revision), conflicting payload conflict, repeated revoke, audit
  evidence for every successful authority-changing command, and
  rollback consistency (failed mutations roll back their audit row).
