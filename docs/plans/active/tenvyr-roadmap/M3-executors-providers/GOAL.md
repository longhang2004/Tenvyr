---
title: "M3 DeepSeek Goal: Executor Architecture and Runtime Integration"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M3-executors-providers/PLAN.md
  - docs/plans/active/tenvyr-roadmap/M3-executors-providers/SPEC.md
  - docs/plans/active/tenvyr-roadmap/M3-executors-providers/VERIFY.md
---

# M3 Goal Mode

## Objective

Implement the approved M3 executor milestone in bounded slices while preserving
M0–M2 authority and keeping provider intelligence inside runtimes.

## Slice order

### Slice 1 — descriptor and compatibility foundation

Inspect current adapter/router/config/attempt code. Implement the smallest bounded
executor descriptor/resolution model, freeze it per attempt, preserve all old
pipelines, and add architecture/real-PostgreSQL evidence. Stop if the design needs
a registry without lifecycle/admin requirements.

### Slice 2 — lifecycle and cancellation capability

Normalize explicit capabilities, errors, runtime identity, and optional cancel.
Reuse canonical outbox/inbox/event authority. Verify unsupported/unreachable cancel
and cancel/result races. Do not add M4 action policy.

### Slice 3 — trusted local process executor

Only if approved in PLAN decisions: prefer a separate executor host/sidecar or
Worker, with fixed trusted command config, argv without shell, controlled cwd/env/
secret refs, bounded IO, process group cancellation, restart/orphan behavior, and
sandbox limitation. Run hostile-input and crash tests.

### Slice 4 — current native/remote integrations

Perform and record official research first. Implement each approved Codex, Claude,
or A2A integration independently using supported auth/runtime mechanisms. A blocked
optional adapter must not cause invented APIs; record it and continue only if M3
closure requirements still hold.

### Slice 5 — provider/runtime examples and closure

Prove provider config remains inside runtimes, run full cross-executor parity,
PostgreSQL twice, SDK/package/docs/identity/security gates, update ledger/current
docs, and create the provisional M3 implementation report.

## Slice rules

- Re-read PLAN/SPEC/VERIFY and current repository before every slice.
- One coherent slice, focused tests, review, status row, then next slice.
- No secrets in durable evidence and no public admin API.
- No provider SDK in Orchestrator/Worker core.
- No shell, arbitrary pipeline command, or unsupported session scraping.
- Do not mark M3 closed. Request independent Sol verification.

## Stop conditions

Stop for PO/Tech Lead decision if mandatory closure integrations are unspecified,
local execution lacks an acceptable sandbox/trust model, official APIs cannot
support required lifecycle/auth, a protocol break is necessary, or external
exposure must be closed. Do not stop for ordinary implementation/test repair.
