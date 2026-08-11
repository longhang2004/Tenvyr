---
title: "M2B: Durable ExecutionState Core"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
plan: in-progress
audience:
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/execution.entity.ts
  - services/orchestrator/src/database/migrations/1722270003000-MilestoneTwoExecutionState.ts
  - services/orchestrator/src/database/database.provider.ts
  - services/orchestrator/src/domain/execution-state.ts
  - services/orchestrator/src/services/execution-state.service.ts
  - services/orchestrator/src/app.module.ts
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - docs/architecture/control-plane.md
  - docs/reference/implementation-status.json
  - docs/reference/implementation-status.md
---

# M2B: Durable ExecutionState Core

> Active implementation plan — IN PROGRESS pending independent Tech Lead
> verification. The Tech Lead inspects, reruns, archives, and selects the
> following slice. This file is an implementation record, not current
> architecture truth; implemented behavior belongs in
> `docs/architecture/control-plane.md`.

## Goal

Implement the durable core for Tenvyr ExecutionState: small structured
mutable values belonging to one execution, an explicit semantic state
version, deterministic bounded top-level patch behavior, safe compare-and-set
mutation under concurrent Orchestrator replicas, and a framework-neutral
internal service suitable for later ContextSnapshot and authoritative
agent-result integration.

## Scope

- Three new `executions` columns: `executionState` (jsonb, NOT NULL, default
  `{}`), `executionStateVersion` (integer, NOT NULL, default 0),
  `executionStateUpdatedAt` (timestamp, nullable until the first real
  mutation), via one ordered migration
  `MilestoneTwoExecutionState1722270003000` (immediately after
  `MilestoneTwoArtifactIdentity1722270002000`).
- One dependency-free domain module `src/domain/execution-state.ts`:
  patch validation, bounded UTF-8 size calculation, deterministic top-level
  patch application, no-op detection, JsonValue safety validation.
- One Orchestrator-internal `ExecutionStateService` (read + compare-and-set
  mutate) registered only in `AppModule`. No controller, Gateway route,
  WebSocket event, CLI, or public package export.
- Unit, migration, real-PostgreSQL integration, concurrency, and failure
  tests.

## Decisions

- **Semantic version, not row version**: `executionStateVersion` is the
  explicit semantic ExecutionState version, incremented exactly once per real
  mutation. TypeORM `rowVersion` keeps guarding the whole database row and
  stays conceptually distinct.
- **Pessimistic compare-and-set**: `mutate` runs in one transaction, locks
  the owning `ExecutionEntity` with `pessimistic_write`, then evaluates
  status and version. Concurrent replicas serialize on the row lock; the
  first writer wins, all stale writers return `conflict` with the current
  version.
- **Precedence**: `missing` → `terminal` → `conflict`. A terminal execution
  rejects mutation regardless of version; conflict reports the current
  semantic version.
- **Validation before transaction**: patch input is validated (including the
  16 KiB canonical-size bound) before any database work, so invalid input is
  a bounded validation error, never a database retry loop. Final-state bounds
  (64 KiB, 128 keys) are checked inside the transaction before saving.
- **Deterministic output**: applied state objects are built with sorted keys,
  so the result never depends on the caller's `set` insertion order.
- **No-op**: an empty patch, a `set` of an identical value, or a `delete` of
  an absent key returns `noop` with the current version and never touches the
  row (no save, no version increment, no timestamp update).
- **Isolation**: `applyStatePatch` never mutates caller-owned objects;
  `read`/`mutate` return `structuredClone`d snapshots so callers cannot
  mutate persisted state by reference.
- **JSON safety**: values must be JSON-clean (no undefined, bigint, function,
  symbol, NaN, Infinity, cycles, class instances, or non-plain objects).
  Validation walks iteratively (explicit stack) so adversarial nesting depth
  cannot overflow the call stack; the 16 KiB patch / 64 KiB state bounds
  bound depth in practice.
- **Dangerous keys**: `__proto__`, `prototype`, `constructor` are rejected in
  both `set` and `delete`.
- **Canonical size**: the UTF-8 byte length of the canonical (sorted-key) JSON
  serialization. Byte count is order-independent, so the iterative validator
  counts exactly without materializing the sorted string.

## Bounds

- maximum 128 top-level state keys;
- maximum key length 128 Unicode code points;
- maximum 128 operations in one patch (|set| + |delete|);
- maximum canonical patch size 16 KiB UTF-8;
- maximum final ExecutionState size 64 KiB UTF-8.

## Patch semantics

```
{ set?: Record<string, JsonValue>; delete?: string[] }
```

- `set` replaces the complete value of each named top-level key.
- `delete` removes named top-level keys.
- Nested values are replaced, never recursively merged.
- A key cannot appear in both `set` and `delete`; duplicate `delete` keys are
  invalid.
- Empty patches are valid no-ops.

## Exclusions (deliberate)

- No agent/result mutation authority: `ResultInboxService` is untouched.
- No `statePatch` field on `AgentResultV1`; `AgentInvocationV1.context` is
  neither populated nor reinterpreted.
- No ContextProjection / ContextSnapshot; no state injection into attempts;
  no artifact consumption references.
- No second state table, event sourcing, revision history, generic
  key/value store, cache, vector database, or new dependency.
- No public read/write API, Gateway route, WebSocket event, CLI, or
  provider prompt construction; no memory/RAG/semantic-search behavior.
- No replay implementation.
- Existing uncommitted M1/M2A changes are the current product baseline and
  are preserved byte-for-byte.

## Source paths

- `services/orchestrator/src/entities/execution.entity.ts` (3 new columns)
- `services/orchestrator/src/database/migrations/1722270003000-MilestoneTwoExecutionState.ts`
- `services/orchestrator/src/database/migrations/milestone-two-execution-state.spec.ts`
- `services/orchestrator/src/domain/execution-state.ts`
- `services/orchestrator/src/domain/execution-state.spec.ts`
- `services/orchestrator/src/services/execution-state.service.ts`
- `services/orchestrator/src/services/execution-state.service.spec.ts`
- `services/orchestrator/src/app.module.ts` (registration)
- `services/orchestrator/src/database/database.provider.ts` (migration list)
- `services/orchestrator/src/database/postgres.integration.spec.ts` (DB cases)
- `docs/architecture/control-plane.md`, `docs/reference/implementation-status.json`,
  `docs/reference/implementation-status.md`, `docs/roadmap/observability-provenance.md`,
  `docs/README.md`

## Validation commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test pnpm --filter orchestrator test -- --runInBand
# ... the real-PostgreSQL command above runs twice sequentially ...
pnpm test:all
pnpm build:all
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
sdks/python-worker/.venv/bin/python -m pytest sdks/python-worker/tests
sdks/python-worker/.venv/bin/python -m ruff check sdks/python-worker/src sdks/python-worker/tests
sdks/python-worker/.venv/bin/python -m ruff format --check sdks/python-worker/src sdks/python-worker/tests
git diff --check
```

Prettier `--check` runs only against the final changed-file set; baseline
skill files are not reformatted.

## Completion criteria

- All five checkpoints done; every validation gate run with recorded exit
  status and counts.
- The real-PostgreSQL suite proves migration order/repeat-safety/preservation,
  `{}` + version 0 for existing and new rows, mutation survival across
  DataSource close/reopen, no-op invariance, terminal rejection, cross-execution
  isolation, forced-failure rollback, 100-way contention (5 rounds, exactly one
  applied per round), sequential chained mutations, and stale-writer
  rejection.
- Final adversarial review confirms: no AgentResult/Artifact data enters
  ExecutionState, rowVersion stays distinct, no stale overwrite, no partial
  commit, no terminal mutation, no public/provider behavior, no new
  dependency or speculative abstraction.
- This plan remains IN PROGRESS; M2B is not closed. The Tech Lead archives it.
