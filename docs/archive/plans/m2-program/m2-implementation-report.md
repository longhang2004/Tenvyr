---
title: "Tenvyr Milestone 2 Implementation Report (M2B–M2F)"
status: historical
superseded_by:
  - docs/archive/reviews/2026-08-11-m2-independent-closure.md
audience:
  - developer
  - product
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/README.md
  - docs/plans/active/tenvyr-roadmap/EXECUTION_STATUS.md
---

# Tenvyr M2 implementation report

Historical implementer report for the M2 program (M2B–M2F), following the
[implementation report template](../../../plans/active/tenvyr-roadmap/IMPLEMENTATION_REPORT_TEMPLATE.md).
Receipts: `docs/_scratch/m2-program/m2b-receipt.md` … `m2f-receipt.md`.

## Implemented

- **M2B — Durable ExecutionState core**: `executionState` (jsonb),
  `executionStateVersion` (semantic version, distinct from TypeORM
  `rowVersion`), and `executionStateUpdatedAt` on the `executions` row;
  dependency-free domain module (deterministic bounded top-level patches,
  canonical UTF-8 size, JSON safety); internal `ExecutionStateService` with
  pessimistic compare-and-set (missing → terminal → conflict precedence).
- **M2C — Bounded ContextSnapshot**: optional `contextProjection.stateKeys`
  at pipeline ingress; immutable per-attempt Tenvyr envelope
  (`context.tenvyr`, 65,536-byte complete-envelope bound, canonical ordering,
  isolated values) committed atomically with the StepAttempt and the
  DispatchOutbox invocation inside `claimRunnableStep`; deterministic
  projection failures (`TENVYR_CTX_*`) persist a terminal pre-dispatch attempt
  and apply the frozen retry/continue/stop policy with no outbox and no READY
  poison loop; both Worker SDKs observe successful envelopes through their
  existing invocation surface.
- **M2D — Artifact projection and exposure lineage**: optional
  `contextProjection.artifacts` selectors (transitive-dependency producers
  only); authoritative resolution from canonical APPLIED successful results
  with verified descriptor ordinals; bounded references
  (artifactId, producerStepId, producerAttemptId, descriptorOrdinal, name,
  mediaType, uri, opted-in metadata; 128 max, deterministic sort); append-only
  `artifact_exposures` edges committed atomically with the claim; URIs are
  opaque and never dereferenced; lineage queryable internally without a
  public API.
- **M2E — Controlled state writes**: optional `stateWrites` with restricted
  RFC 6901 JSON Pointers into `AgentResultV1.output`; static same-key
  write-conflict rule at pipeline ingress (DAG-proven ordering required);
  mappings applied inside the canonical `ResultInboxService.apply`
  transaction under the already-locked execution entity with exact
  version/no-op semantics; deterministic postcondition failure
  (`TENVYR_STATE_WRITE_REJECTED: …`) follows retry/`onFailure` policy with
  no transport poison loop; append-only `state_write_evidence` provenance;
  no `AgentResultV1.statePatch`.
- **M2F — Hardening**: cross-stage combined chain (state + artifacts +
  writes + restart + legacy pair), 100-way contention profiles, exact
  bound profiles (128 refs, 128 mappings at the 16 KiB patch ceiling,
  final-state 64 KiB ceiling on the result path), M0/M1 → M2A–E upgrade
  matrix, log/URI adversaries, full gate ladder.

## Architectural decisions

- State, snapshot, artifact, and evidence authority stay inside the existing
  transaction seams: `claimRunnableStep` (claim) and `ResultInboxService.apply`
  (result) — no new scheduler or mutation authority.
- Exposure semantics are authoritative: edges prove projection, never
  dispatch/consumption; FK deletion is NO ACTION to protect audit truth.
- `AgentInvocationV1.context` is written only by the reviewed claim seam via
  the domain envelope builder; adapters/dispatch/recovery never synthesize it
  (architecture-guarded).
- Mapping/projection failures are deterministic execution outcomes, not
  transport retries; stable codes, no value leakage.
- Review-driven fix: state-write application reordered after the attempt
  terminal-outcome precedence check (late results commit nothing).

## Migrations and data changes

Registered order (verified against the live list before each allocation):

```text
1722270000000  M0 Foundation (pre-existing)
1722270001000  M1 AgentEvents (pre-existing)
1722270002000  M2A ArtifactIdentity (pre-existing)
1722270003000  M2B ExecutionState columns (existing rows get {} version 0 via defaults)
1722270004000  M2D artifact_exposures (uuid pk, NO ACTION FKs, unique (stepAttemptId, artifactId), artifact index)
1722270005000  M2E state_write_evidence (uuid pk, NO ACTION FKs, unique resultInboxId, attempt/execution indexes)
```

No M2C migration: `step_attempts.contextSnapshot` has existed since M0.
No historical backfill anywhere; upgrade proven on a seeded M0/M1 database
(zero loss, zero fabrication); every migration repeat-safe (`IF NOT EXISTS`
convention) with reviewed `down`.

## Tests and verification evidence

Real PostgreSQL (disposable `tenvyr_m2_test`, PostgreSQL 18.4) — every
migration/durability/lock/race/rollback claim runs against it, twice
sequentially per stage (three times after final repairs):

- Final: `pnpm --filter orchestrator test -- --runInBand` PASS (460 passed,
  98 skipped); `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test pnpm --filter orchestrator test -- --runInBand` PASS ×3 (558/558, 35 suites).
- `pnpm test:all` PASS; `pnpm build:all` PASS; `pnpm test:docs` /
  `pnpm verify:docs` PASS (81 md, 172 links); `pnpm test:identity` /
  `pnpm verify:identity` PASS (0 violations); `pnpm verify:package-packs` PASS.
- `sdks/python-worker/.venv/bin/python -m pytest sdks/python-worker/tests`
  PASS (261); ruff check/format PASS; `sync-python-worker-schemas.py check`
  PASS (5/5); `verify-python-worker-package.py` PASS (venv python).
- `pnpm --filter @tenvyr/worker test` PASS (199) incl.
  `jest --runInBand --detectOpenHandles` (no open handles).
- `pnpm exec prettier --check <changed>` / `git diff --check` PASS.
- Failure injections: outbox insert, exposure insert, artifact registration,
  provenance insert (each: full rollback + clean retry of the identical
  payload); 100-way result/claim/state contention with exact row counts;
  DataSource close/reopen after every commit class.

Skipped/unavailable (recorded, not passes): orchestrator
`test:python-worker-loopback` (needs `TENVYR_PYTHON_EXECUTABLE`; Worker
runtime untouched by M2 — not applicable per operations doc) and Java
`mvn test` (runner untouched). No external research was required: M2 touches
no external APIs (no provider/runtime integration).

## Security review

- URI-001: static architecture guard (no fetch/dns/fs/http-client/`open(`
  sink in any Orchestrator path touching artifact URIs) + dynamic
  hostile-URI survival test (byte-identical, never fetched).
- Trust boundaries: state values, projection selectors, artifact descriptors,
  pointers, and output values all validated/bounded (keys, counts, UTF-8
  bytes, JSON safety, unsafe keys `__proto__`/`prototype`/`constructor`).
- AUTH-001: same-execution artifact enforcement + defensive foreign checks.
- LOG-001: log/error adversary proves state values and URIs never reach logs;
  stable codes only.
- No new public routes or controllers; external exposure gate still open
  (documented limitation, no sensitive public API added).
- No new dependencies; no provider SDK/RAG/Planner/budget/replay code.

## Remaining limitations

- Exposure proves projection, not dispatch/consumption; artifact bytes never
  owned, fetched, verified, or claimed immutable.
- No public state/artifact/lineage/evidence API (unauthenticated APIs remain;
  external production exposure gate open).
- Mutation evidence is not full event-sourced history; no replay.
- M2C historical null snapshots remain null; no exposure/provenance backfill.
- Patch semantics are top-level key set/delete; nested merges future work.
- python-worker loopback gate not run (not applicable; Worker runtime
  unchanged) — Sol may run it with `TENVYR_PYTHON_EXECUTABLE` configured.

## Closure status

`CLOSED` after independent Tech Lead verification on 2026-08-11. The
[independent closure review](../../reviews/2026-08-11-m2-independent-closure.md)
records three repaired correctness gaps and the final verification ladder.

# Milestone handoff

## What was delivered

Durable bounded ExecutionState; opt-in state projection into immutable
per-attempt ContextSnapshots committed atomically with dispatch; explicit
artifact reference projection with append-only exposure lineage; pipeline-
declared controlled state writes from canonical results with provenance;
hardening, upgrade, and adversarial evidence across the whole program.

## User/operator value

Pipelines can share small execution-scoped values and reference produced
artifacts explicitly — with deny-by-default projection, hard bounds, exact
audit lineage, and deterministic failure behavior — without copying bytes
into prompts or inventing agent-controlled state mutation.

## How it works

Declarative `contextProjection` (state keys + artifact selectors) and
`stateWrites` (RFC 6901 output pointers) live in the frozen pipeline step
spec. Claims freeze snapshots and exposure edges in one transaction;
canonical results apply declared state under the existing result transaction;
everything is bounded, versioned, and queryable from PostgreSQL.

## Guarantees

All-or-nothing claim/result commits; exactly-once state application and
provenance; no state write for late/conflicting/cancelled results;
same-execution-only artifact exposure; URIs never dereferenced; values never
logged; old pipelines byte-identical.

## Known limitations

See "Remaining limitations" above.

## Architecture decisions

Single-authority seams (`claimRunnableStep`, `ResultInboxService.apply`);
pure domain validation shared across M2B–E; exposure semantics over
consumption semantics; mutation provenance over event sourcing.

## What this unlocks

M3 (executor architecture) may proceed: attempts now carry
durable bounded context, artifacts have identity + exposure lineage, and
results have controlled state effects — the substrate executors will
supervise.

## Verification summary

All stage gates and the full final ladder green against real PostgreSQL
(558/558 ×3), both Worker SDKs, docs/identity/package verifiers, and the
formatting gates; failures found during the run (including the independent
review's ordering finding) were root-caused, repaired, and re-verified.

## Recommended next milestone

M3 — Executor architecture and runtimes (`READY`).
