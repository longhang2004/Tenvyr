---
title: "M2F Specification: Program Hardening and Closure Readiness"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - docs/operations/testing-and-verification.md
  - docs/reference/implementation-status.json
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M2F hardening and closure specification

## Outcome

M2F introduces no new product capability. It closes cross-stage correctness,
durability, scale, security, migration, compatibility, documentation, and
reviewability gaps discovered when M2B-E run as one system.

The output is a repository state ready for independent Tech Lead verification,
not a self-approved or archived milestone.

## System invariants to prove together

1. ExecutionState remains small, bounded, versioned, and separate from TypeORM
   row version, result output, artifact descriptor storage, and snapshot history.
2. Every projected attempt can be reconstructed from durable facts: frozen step
   spec, immutable snapshot, exact outbox invocation, observed state version,
   artifact exposure edges, and producer lineage.
3. No dispatch recovery path recomputes context.
4. No canonical result path can apply artifacts or state writes twice.
5. Projection/controlled-write failures terminate deterministically without
   transport poison loops or partial authority.
6. M0 durable execution, M1 AgentEvents/supervision, and M2A producer artifacts
   retain their authority boundaries and recovery behavior.
7. Old pipelines with no M2C-E declarations remain behaviorally compatible.
8. Current docs and the implementation ledger describe executable truth and its
   limitations without claiming replay, byte storage, auth, or semantic memory.

## Scale and bound profiles

Add deterministic tests for exact limits rather than open-ended benchmarks:

- ExecutionState at maximum keys/bytes and patch operation count;
- ContextSnapshot at exact key/reference/UTF-8 boundary and one unit over;
- 128 artifact references with bounded descriptors and opted-in metadata;
- 128 controlled state mappings with a final state at exact boundary;
- repeated attempts/retries proving linear append-only exposure/provenance growth;
- 100-way claim/state/result contention rounds with exact row/version counts;
- large canonical AgentResult output proving undeclared data is never copied;
- multibyte/astral Unicode showing byte count is UTF-8, not code units.

Tests must be bounded enough for routine CI and still fail on accidental O(n²)
or unbounded-copy regressions at approved maxima. Do not add a benchmark framework.

## Crash/restart matrix

Using real PostgreSQL and current recovery mechanisms, inject or simulate crashes
at these authority boundaries:

- before and after attempt/snapshot/outbox commit;
- after outbox claim but before/after adapter handoff;
- before and after canonical ResultInbox commit;
- during artifact registration;
- during controlled state update and provenance insert;
- after commit but before in-process acknowledgement;
- DataSource close/reopen before reread/redelivery.

The recovered database must expose exactly one coherent pre-commit or post-commit
truth. Never infer successful work from in-memory objects.

## Migration matrix

Prove both:

- clean database applies every production migration in registered order; and
- representative pre-M2 database with M0/M1 rows upgrades through M2A-E without
  data loss, fabricated snapshots/exposures/provenance, or altered event/result
  authority.

Verify exact columns, defaults, constraints, foreign keys, uniqueness, indexes,
migration table identities, repeat convention, and reviewed down behavior. Run
the application twice against the upgraded database to catch startup drift.

## Security closure

- Search and architecture-test that artifact URI has no network/file/path execution
  sink in Orchestrator.
- Prove unsafe JSON keys and excessive nesting fail at every new trust boundary.
- Capture logs/errors for hostile state/output/artifact values and prove values are
  absent.
- Prove same-execution artifact authorization and no public state/context/artifact
  route was accidentally added.
- Confirm no provider SDK, prompt construction, RAG, vector, semantic-memory,
  Planner, subagent, budget, policy, approval, or replay executor dependencies.
- Review SQL/query construction for parameterization and bounded result sets.

## Documentation and ledger closure

Update current architecture, contracts, testing guidance, status narrative, and
machine ledger only after executable gates pass. Every implemented capability needs
real source/test/doc paths. Limitations must explicitly include:

- no artifact byte ownership or external-byte immutability guarantee;
- no URI dereference or public artifact API;
- no auth/tenant sharing policy;
- historical null snapshots and no fabricated exposure/provenance backfill;
- exposure does not prove semantic consumption;
- mutation evidence is not full event-sourced state history;
- replay/Execution Capsule execution remains future work.

Plans and specs remain `status: planned` under `docs/plans/active/`. DeepSeek may
record readiness receipts but must not archive or mark closure.

## Non-goals

No new storage adapter, blob service, public query API, auth system, policy engine,
MemoryRef implementation, semantic search, provider integration, Planner, budgets,
native subagents, replay runner, or Execution Capsule product is allowed in M2F.

## Acceptance requirements

M2F is ready for review only when the complete global anti-regression matrix, full
gate ladder, two sequential PostgreSQL runs, migration upgrade path, crash/restart
matrix, final file-by-file review, docs/identity/package verification, and final
receipt are green with no waived failures.
