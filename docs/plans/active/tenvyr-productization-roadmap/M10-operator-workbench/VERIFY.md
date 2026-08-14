---
title: "M10 Verification: Operator Workbench and Product Wedge"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/SPEC.md
  - docs/operations/testing-and-verification.md
  - docs/showcase/demo-guide.md
---

# M10 verification contract

## Architecture audit

UI/read models project existing authority; commands call reviewed services and never
advance work directly; no frontend workflow state machine; no secret/raw-context
surface; external production limitation is visible; no provider router/designer.

## Unit tests

Projection pagination/bounds/redaction/truncation; status and reason mappings;
idempotency/stale command conflicts; limit form validation; safe preview; role and
iteration semantics; unavailable sections; accessibility helpers and audit records.

## Real PostgreSQL tests

Command idempotency and stale races; approval/cancel/replay/connection revocation
authority; projection coherence during worker/result/decision transitions;
operator-action audit persistence; restart and migration compatibility. Run twice
when transactions, locks, ownership, or migrations change.

## Integration and end-to-end tests

Gateway/Orchestrator/frontend loopback; refresh/reconnect and missed Socket.IO event;
connection test -> launch -> two iterations -> WAIT decision -> terminal Capsule;
failure/cancel/replay/compare; bounded large run; deterministic offline showcase;
optional installed Codex/Claude/OpenCode path with explicit unavailable/live result.

## Crash/restart and multi-replica

Browser closes/reopens at every phase; Gateway restarts; Orchestrator restarts;
duplicate commands from two tabs; approval/cancel and replay races; stale connection
card and phase data. Server truth must win without duplicate authority action.

## Security review

Unauthenticated non-loopback exposure, CSRF/origin and WebSocket assumptions, secret
and credential-ref search, ID enumeration, oversized queries/goals/previews/graphs,
HTML/script injection, external artifact URI rendering, log/context leakage,
approval replay and resource request storms. Record gate limitations honestly.

## Accessibility and compatibility

Keyboard-only primary workflow, visible focus, semantic names, status not color-only,
screen-reader table alternative for graphs, narrow viewport and zoom. Preserve old
dashboard/API behavior or version migrations. Update demo, README, architecture,
operations, identity, implementation ledger and explicit non-claims.

## Required commands

```bash
pnpm --filter frontend test:safe-preview
pnpm --filter frontend lint
pnpm --filter frontend typecheck
pnpm --filter gateway test
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm test:all
pnpm build:all
pnpm showcase:up
pnpm showcase:smoke
pnpm showcase:down
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
git diff --check
```

Add the smallest browser accessibility/responsive test gate selected by the
implementation and record its exact command; do not report an unavailable future
command as passed.

## Closure gate

`SAFE TO CLOSE` requires independent Sol completion of the entire offline product
wedge, refresh/race/security/accessibility review, authoritative projections, visible
limitations and evidence-based discovery record. DeepSeek cannot close M10.
