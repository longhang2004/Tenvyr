---
title: "M2C Implementation Plan: Bounded State ContextSnapshot"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/20-m2c-context-snapshot-spec.md
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/engine.service.ts
  - services/orchestrator/src/architecture.spec.ts
---

# M2C implementation plan

Execute in order. Do not start M2D until the M2C verification file is green.

## Checkpoint C1 — freeze executable contracts

1. Inspect the live M2B implementation and tests; reuse its JSON/key/UTF-8
   validation primitives where their semantics match.
2. Add the narrow optional `contextProjection.stateKeys` type to pipeline step
   configuration and make pipeline validation retain and validate it.
3. Add focused validation tests for absent, valid, empty, duplicate, unsafe,
   over-count, over-length, malformed, and unknown nested configuration.
4. Prove the new field participates in plan revision storage and frozen spec
   hashing while old step specs retain their prior canonical form.

Checkpoint receipt: selector shape, exact error codes, bounds, and tests.

## Checkpoint C2 — pure snapshot materialization

1. Add one dependency-free domain function/module that receives validated
   projection config plus an ExecutionState snapshot and returns the versioned
   Tenvyr snapshot envelope.
2. Select only exact top-level keys, copy into isolated JSON values, sort keys
   canonically, and compute complete-envelope canonical UTF-8 size.
3. Reuse the existing JSON safety contract. Do not build a general expression
   engine or generic serialization framework.
4. Add table-driven unit tests including Unicode, null, nested values, unsafe
   keys, missing keys, boundary bytes, one byte over, input-order independence,
   and output isolation from later object mutation.

Checkpoint receipt: pure API, canonical form, boundary calculations.

## Checkpoint C3 — atomic claim integration

1. Integrate snapshot creation into `ExecutionService.claimRunnableStep` only
   after the existing execution lock is held.
2. Persist the exact snapshot on the attempt and deep-equal Tenvyr envelope in
   the outbox invocation within the same transaction.
3. Preserve the absent-selector legacy path exactly.
4. Address deprecated `createStepExecution`: either route it through the same
   invariant or prove with an architecture test that it cannot create authoritative
   projection-enabled attempts. Do not leave a second inconsistent path.
5. Convert projection failures into the existing deterministic step failure
   policy with no outbox. Do not allow a poison READY loop.
6. Replace M2B's broad architecture prohibition on invocation context with a
   narrower contract permitting only this reviewed claim seam and forbidding
   adapters/dispatch recovery from synthesizing it.

Checkpoint receipt: transaction owner, lock order, failure disposition, legacy
path behavior, architecture guard.

## Checkpoint C4 — transport and Worker conformance

1. Prove DispatchOutbox stores the invocation containing the exact snapshot.
2. Prove dispatcher retries and restart recovery reparse and send that persisted
   invocation without recomputation.
3. Prove HTTP and Kafka adapter paths preserve the envelope unchanged.
4. Prove TypeScript and Python Worker handlers can observe the envelope through
   their existing invocation surfaces. Add no convenience API unless repository
   evidence makes it necessary for correctness.
5. Verify callback/result behavior remains independent of context.

Checkpoint receipt: cross-path fixture and equality evidence.

## Checkpoint C5 — durable migration and docs

1. Prefer the existing `step_attempts.contextSnapshot` column. Add no migration
   if no durable schema change exists.
2. If a schema constraint/index is genuinely required, use the next live migration
   number and prove ordered, repeat-safe upgrade plus historical-null preservation.
3. Update current control-plane/contracts/implementation-status documentation to
   describe only implemented behavior and limitations.
4. Update the machine ledger with real source/test evidence only after tests pass.
5. Do not archive this plan or the program package.

Checkpoint receipt: migration decision and documentation paths.

## Mandatory implementation review questions

- Can any state read occur before the execution lock and still influence snapshot?
- Can an outbox retry observe current rather than persisted state?
- Can absent projection alter old invocation serialization or frozen hashes?
- Can a failure leave an attempt without outbox or a READY poison loop?
- Can selected state values appear in logs/errors?
- Can any provider-specific code interpret this snapshot?

If any answer violates the specification, repair before running the final gate.
