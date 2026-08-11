---
title: "M2 Global Verification and Anti-Regression Contract"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - services/orchestrator/src/architecture.spec.ts
  - packages/contracts/test/schema-identity.spec.ts
  - scripts/verify-docs.mjs
  - scripts/verify-product-identity.mjs
---

# Global verification and anti-regression contract

This file defines evidence every remaining M2 stage inherits. A stage-specific
verification file may add gates but may not weaken these invariants.

## Evidence rules

- Test behavior through the real transaction owner, not only private helpers.
- Durable, migration, lock, rollback, restart, and concurrency claims require
  real PostgreSQL. Mocks may supplement but never substitute.
- Test old inputs and absent new configuration to prove compatibility.
- Assert database truth using raw SQL when an ORM could hide defaults, generated
  values, or write order.
- Record exact commands, exit status, counts, and relevant output in the stage
  receipt. A prose claim such as "tests pass" is insufficient.

## Safe PostgreSQL rule

The destructive integration harness may target only a disposable database named
`tenvyr_m2_test`. It must not target `postgres`, `template0`, `template1`, the
configured application database, or any shared environment. Use the repository's
disposable-target guard and additionally inspect the URL before running.

Canonical command:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand
```

Run this suite twice sequentially after the first clean result. Do not run the
two durability passes concurrently.

## Required anti-regression matrix

| ID             | Bug class                  | Required proof                                                                                                 |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ATOMIC-001     | Partial claim              | snapshot, attempt, outbox, and applicable artifact edges all commit or all roll back                           |
| REDELIVERY-001 | Context recomputation      | dispatch retry/redelivery sends the persisted outbox invocation byte-equivalent context                        |
| DUP-001        | Duplicate result           | identical redelivery creates no second artifact, state write, version increment, or disposition change         |
| CONFLICT-001   | Conflicting result         | conflicting payload preserves the first canonical result and applies no later mutation                         |
| CANCEL-001     | Late/cancelled result      | cancellation and terminal execution cannot be resurrected or mutate state                                      |
| RETRY-001      | Attempt identity collapse  | each retry owns a distinct snapshot and exposure edges; one outbox retry does not                              |
| RACE-001       | Torn state read            | claim racing state mutation sees the complete old or new state version, never a mixture                        |
| AUTH-001       | Cross-execution artifact   | foreign Artifact UUID/reference cannot enter snapshot or lineage                                               |
| EVENT-001      | Event authority confusion  | AgentEvent artifact evidence cannot create or satisfy an authoritative Artifact reference                      |
| BOUND-001      | Amplification              | complete envelope, selection counts, key lengths, nesting, strings, and UTF-8 bytes are bounded                |
| JSON-001       | Unsafe JSON                | `__proto__`, `prototype`, `constructor`, non-finite numbers, non-JSON values, and excessive depth are rejected |
| URI-001        | URI dereference            | no Orchestrator path fetches, probes, resolves, reads, or executes artifact URI content                        |
| DATA-001       | Large-output leak          | result output and artifact bytes never automatically enter ExecutionState or ContextSnapshot                   |
| LEGACY-001     | Old pipeline drift         | a pipeline without the new fields retains old invocation, input, scheduling, retry, and result behavior        |
| MIG-001        | Unsafe upgrade             | migration order, repeat application, preserved rows, clean rollback, and no invented backfill are proven       |
| LOG-001        | Sensitive logging          | logs/errors contain IDs, versions, counts, hashes, and codes—not context/state/output/URI/metadata values      |
| SDK-001        | Cross-language drift       | official TypeScript and Python Workers observe the same invocation/result semantics                            |
| DOC-001        | False implementation claim | current docs and ledger cite executable evidence; planned docs remain plans                                    |

## Failure-injection patterns

Use the repository's existing patterns rather than adding a framework:

1. Rename a newly required table inside a test to force a late insert failure,
   restore it in `finally`, and prove all earlier transaction writes rolled back.
2. Install a PostgreSQL `BEFORE INSERT` or `BEFORE UPDATE` trigger that raises,
   remove it in `finally`, and prove clean retry.
3. Close the original DataSource, open a fresh one through production migration
   options, and re-read committed truth.
4. Race replicas with `Promise.all`, count exact dispositions, and query final
   rows directly. Repeat the round enough to expose timing-dependent merges.
5. Remove only the new table/column after prior migrations, seed old rows, run the
   new migration twice, and prove preservation plus no historical fabrication.

## Contract and package rules

Agent Protocol v1 root schemas are closed. Any canonical schema change requires
an explicit compatibility review plus all of:

- canonical JSON Schema and TypeScript types/parser tests;
- deliberate semantic-hash updates;
- five tracked Python schema resources synchronized;
- cross-language conformance fixtures;
- package-pack byte equality and external-consumer checks;
- current contract documentation.

The preferred M2 design does not add `AgentResultV1.statePatch`; state authority
comes from pipeline-declared output mappings. Reusing the existing optional
`AgentInvocationV1.context` for a versioned Tenvyr envelope should not require a
root schema change.

## Gate ladder

Run focused tests during development, then the applicable stage gate. At final
M2F completion run and record every command below separately:

```bash
pnpm --filter orchestrator test -- --runInBand

TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand

TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand

pnpm test:all
pnpm build:all
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs

sdks/python-worker/.venv/bin/python -m pytest sdks/python-worker/tests
sdks/python-worker/.venv/bin/python -m ruff check \
  sdks/python-worker/src sdks/python-worker/tests
sdks/python-worker/.venv/bin/python -m ruff format --check \
  sdks/python-worker/src sdks/python-worker/tests

python scripts/sync-python-worker-schemas.py check
python scripts/verify-python-worker-package.py

pnpm exec prettier --check <all-final-changed-non-python-files>
git diff --check
```

If HTTP Worker behavior changes, add the repository's loopback/open-handle HTTP
gate. If Kafka invocation behavior changes, run the Kafka adapter/Worker suites
and any configured broker-backed gate. Record unavailable external infrastructure
as a blocker only after local repository-supported setup is exhausted.

## Receipt schema

Each `docs/_scratch/m2-program/<stage>-receipt.md` must contain:

1. baseline timestamp, branch, HEAD, and `git status --short`;
2. requirement and anti-regression IDs with source/test evidence paths;
3. production, migration, test, contract, SDK, and documentation file inventory;
4. exact command table with exit status, counts, duration, and database name;
5. failure injections, observed failure, rollback truth, and clean retry truth;
6. encountered failures and repairs;
7. remaining limitations and stage readiness phrase;
8. final status and diff summary so the Tech Lead can attribute a long dirty-tree run.

The receipt is evidence for review, not independent verification.
