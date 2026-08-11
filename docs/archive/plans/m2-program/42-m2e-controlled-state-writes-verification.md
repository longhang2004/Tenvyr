---
title: "M2E Verification Plan: Controlled Result-to-State Writes"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - services/orchestrator/src/services/result-inbox.service.spec.ts
  - services/orchestrator/src/services/execution-state.service.spec.ts
  - packages/contracts/test/validation.spec.ts
---

# M2E verification plan

## Mapping and pipeline cases

- valid object/array pointers, `~0`/`~1`, explicit null, and isolated copied value;
- empty pointer, fragment, wildcard, expression, invalid escape, `-`, negative,
  leading-zero index, missing path, scalar traversal, unsafe key, duplicate target,
  empty/too-many mapping, and one-byte-over bounds;
- identical keys in unordered branches rejected; disjoint parallel writers accepted;
- same key in transitively ordered steps accepted; graph orientation is correct;
- mapping changes affect frozen spec hash; absent field preserves old canonical spec;
- full result output is never copied when only one pointer is declared.

## Result decision matrix

For configured and unconfigured steps test:

- first canonical succeeded result with real change;
- succeeded semantic no-op;
- failed, cancelled, timed-out, and watchdog result;
- identical duplicate and conflicting duplicate;
- ignored/stale invocation and reused transport receipt;
- post-cancel result and late sibling after terminal execution;
- mapping missing/invalid/oversized/final-state-over-limit;
- artifact-producing succeeded result with applied/noop/rejected mapping.

Assert exact ResultInbox disposition, attempt/logical/execution status, retry/
`onFailure` behavior, artifact count, state/version/timestamp, provenance count and
disposition, and stable error code for every row.

## Real PostgreSQL atomicity and races

1. State change, terminal transitions, artifacts, and provenance commit together.
2. Trigger failure on state update rolls all other effects back; clean retry works.
3. Artifact insert failure rolls state/provenance/result transitions back.
4. Provenance insert failure rolls state/artifacts/result transitions back.
5. Terminal transition failure rolls state/artifacts/provenance back.
6. Identical redelivery after commit is a complete no-op.
7. Conflicting redelivery preserves first canonical state/evidence.
8. One hundred disjoint parallel writers preserve every key and exact version count.
9. Two result writes plus M2B mutation serialize without lost update/torn state.
10. Result/cancel race never resurrects execution or writes after cancellation.
11. Restart re-read proves committed state/evidence and exactly-once redelivery.
12. Migration preserves historical state/results and invents no provenance.

## Contract and security assertions

- `AgentResultV1` canonical schema remains version 1 without `statePatch`.
- Result metadata cannot authorize a write.
- Error/log capture contains no selected output values, state values, or full patch.
- Architecture guard prevents business services other than canonical ResultInbox
  integration from applying pipeline result mappings.
- Old Workers and protocol fixtures still validate old/new result payloads because
  the wire result schema did not change.

## Required gates

Run focused pointer, pipeline, ResultInbox, ExecutionState, migration, architecture,
contract, Worker, and PostgreSQL tests, then the complete commands:

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
python scripts/sync-python-worker-schemas.py check
python scripts/verify-python-worker-package.py
pnpm exec prettier --check <m2e-changed-non-python-files>
git diff --check
```

Record results in `docs/_scratch/m2-program/m2e-receipt.md`.

## Stop conditions

Stop for Tech Lead review if the current state machine cannot durably represent a
canonical succeeded result whose required state mapping failed, or if correctness
would require a v1-breaking result field, nested transaction, arbitrary agent
patch, or endless transport retry.
