---
title: "M6 Verification: Native Agents, Delegation, and Supervised Subagents"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M6-delegation-subagents/SPEC.md
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - services/orchestrator/src/services/agent-event.service.spec.ts
---

# M6 verification contract

## Static architecture audit

- opaque/observed/supervised labels match actual authority;
- events/metadata cannot create child execution or mutate lifecycle/budget;
- child creation reuses one manager-aware execution materializer;
- authority can only narrow and depth is server-derived;
- parent pause/resume exists only for capability-proven runtimes;
- cancellation uses bounded durable propagation, not recursive ad-hoc transactions;
- no provider-specific reasoning enters Orchestrator.

## Unit tests

- mode validation and capability negotiation;
- observed report bounds/hash/idempotency/conflict/late evidence;
- supervised request identity/hash/decision and failure policy;
- permission/budget/deadline/depth/fanout subset rules;
- parent wait/resume continuation identity and duplicate rejection;
- graph ordering/pagination and observed/supervised labels.

## Real PostgreSQL tests

- 100 concurrent identical requests create exactly one Delegation/child Execution;
- same request ID/different payload creates conflict, no second child;
- delegation/reservation/child/revision/logical rows/relation commit all-or-none;
- trigger failures at each late insert roll back and clean retry succeeds;
- 100 concurrent fanout requests cannot exceed ceiling;
- server-derived depth cannot be bypassed by runtime claims;
- parent cancel versus child create/result/continuation leaves no runnable orphan;
- descendant cascade restart completes exactly once without deadlock;
- parent/child deadlines and budgets remain narrowed after restart;
- migration preserves old executions and invents no edges/evidence.

## Integration tests

- deterministic mock runtimes for opaque, observed, supervised;
- each approved Codex/Claude/A2A capability using current official fixtures;
- parent pause/resume heartbeat/supervision/capacity/deadline behavior;
- TypeScript/Python protocol parity where delegation is portable;
- M4 policy/approval/budget and M3 cancel/runtime failure interaction;
- M5 not required inside child reasoning; child plan remains valid immutable work.

## Crash/restart and races

Crash before/after request, reservation, child materialization, runtime dispatch,
child result, continuation, and cascade intent. Race duplicate requests, fanout,
parent cancel/approval, child result/cancel, continuation/retry, and ancestor budget.

## Security review

Test forged parent/attempt, cross-execution ownership, runtime-reported depth,
permission/credential widening, recursive/delegation bomb, oversized scope/reason/
input, replayed request, compromised observed reporter, A2A impersonation, and
sensitive graph logging. Public graph/control remains exposure-gated.

## Compatibility and docs

Opaque old runtimes and M0–M5 execution semantics stay green. Update current
delegation architecture, capability matrix, status ledger, limits, cancellation,
security/exposure limitations, and official research citations.

## Required current commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm test:all
pnpm build:all
pnpm --filter @tenvyr/worker test
python -m pytest sdks/python-worker/tests
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
git diff --check
```

Run PostgreSQL twice sequentially and each researched native/A2A integration gate.

## Closure gate

SAFE TO CLOSE only if Sol independently proves truthful modes, exactly-one child,
strict inheritance, safe wait/resume, no orphan after crash/cancel, bounded explosion,
security/compatibility, and current documentation. DeepSeek is provisional.
