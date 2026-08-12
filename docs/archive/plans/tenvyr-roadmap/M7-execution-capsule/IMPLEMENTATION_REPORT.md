---
title: "M7 Implementation Report"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
  - product
last_verified: 2026-08-12
sources:
  - services/orchestrator/src/services/execution-capsule.service.ts
  - services/orchestrator/src/services/delegation.service.ts
  - services/orchestrator/src/agent-adapters/http-agent.adapter.ts
  - services/orchestrator/src/services/execution.service.ts
---

# M7 implementation report — execution capsule, replay, provenance, telemetry

Date: 2026-08-12
Status: **CLOSED — independent Tech Lead PASS.** See the
[durable closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
Slices: 5/5 complete (S1 capsule read model, S2 export manifest + replay,
S3 comparison + provenance, S4 OTLP/W3C projection, S5 observability
closure). Provisional until the independent SOL review.

## What M7 delivers

- **Execution Capsule V1 (M7-S1)** — bounded read model assembled from
  authoritative rows in one REPEATABLE READ transaction: header (pipeline
  hash, active revision hash, bounded input with truncation markers,
  configuration), immutable revisions, bounded attempts (DAG step ids),
  outbox/inbox/conflict/event counts, budget account + reservations,
  policy snapshot + decisions, approvals, the M6 delegation graph (read
  through the capsule's own snapshot). Terminal/live labelling; every
  bound that bit is an `evidenceCompleteness` warning; `contentHash` is
  stable over durable facts (volatile capture fields and the GLOBAL
  policy snapshot excluded — terminal hashes never drift). Service-level
  only.
- **Export manifest + controlled replay (M7-S2)** — `execution_exports`
  (pin-only immutable manifests, idempotent) and `execution_replays`
  (idempotent per source/capsule, serialized under the source execution lock).
  Replay materializes a NEW
  execution from the CAPTURED plan + input in one transaction (terminal
  sources only); ALL authority is re-evaluated by the normal claim
  machinery — a rotated DENY policy blocks the replay's dispatch and zero
  approvals are copied.
- **Comparison + provenance (M7-S3)** — `compare` over stable logical
  identities: plan drift (step id + spec hash), outcome drift (TERMINAL
  attempt statuses; no_evidence_both is its own category), truncated/live
  sections are `unavailable` (never concluded), runtime claims never part
  of drift. `provenance` derives a bounded graph distinguishing authority
  edges from claim edges (observed delegation) and exposure edges (read
  through the claim seam's bounded API — the M2 boundary holds); every
  edge resolves to a node.
- **OTLP/W3C projection (M7-S4)** — bounded OTLP-JSON-shaped telemetry
  derived from the capsule (deterministic trace/span ids, root FAILED
  status, client-kind attempt spans; NEVER authoritative — pure read).
  W3C traceparent propagates OUTBOUND ONLY in the HTTP adapter
  (deterministic from the invocation's own trace identity; malformed and
  all-zero ids rejected; inbound headers never trusted).
- **Observability closure (M7-S5)** — the architecture spec enforces
  that no controller exposes the capsule/export/replay/provenance/
  telemetry surfaces; boundedness proven on a 150-attempt execution
  (capsule ≤ 100 attempts + warning, telemetry ≤ 101 spans, provenance
  ≤ 200 nodes / 500 edges).

## Verification (final state)

- Unit: orchestrator 543 passed / 253 skipped (PG) / 0 failed.
- Real PostgreSQL: 777/778 ×3 sequential — M7-S1 5, M7-S2 7, M7-S3 7,
  M7-S4 3, M7-S5 1 = 23 capsule tests (at the REAL final counts
  after the duplicated-describe repair), incl. concurrent replays,
  hash-stability under policy rotation, captured-plan-under-pipeline-
  evolution, dangling-edge detection, and boundedness under scale.
- test:all green (contracts 65, worker 199, host 31, orchestrator 543,
  gateway, agents, example); build:all 15; verify:docs 89 files / 39
  capabilities; verify:identity 0 violations; git diff --check.
- Review findings fixed at every slice: S1 DI + snapshot-consistent
  graph, S2 replay race + hash stability, S3 dangling provenance edges +
  terminal-only outcomes, S4 all-zero trace ids + w3c capability status.
  A stale ts-jest cache had masked TS2322 in three pre-existing specs
  since M6-S5 — fixed (all typed config literals carry delegationModes).

## Known limitations (explicit)

- Export/replay/projection are service-level; the public API stays
  behind the External Production Exposure Gate (no auth/ownership API
  exists — by design).
- The OTLP projection is a mapper shape, not a wired exporter process;
  timings are unavailable ("0") in the structural projection.
- tracestate is not propagated; inbound W3C context is never trusted.
- Cross-replica revision/hash consistency remains out of scope (M5
  limitation, unchanged).

## Independent closure

**PASS — CLOSED 2026-08-12.** Independent review serialized export/replay
creation races; preserved authoritative large inputs with hashes; replaced
fabricated provenance identifiers with durable policy-decision identities;
made graph bounds edge-safe; bounded telemetry to static low-cardinality span
names and 101 spans; and expanded capsules with context, state, artifact,
policy, and delegation facts. Final evidence is in the
[durable M3–M7 closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
