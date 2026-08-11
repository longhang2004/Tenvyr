---
title: "M2C Specification: Bounded State ContextProjection and ContextSnapshot"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/domain/pipeline-definition.ts
  - services/orchestrator/src/services/pipeline-validation.service.ts
  - packages/contracts/src/types.ts
  - contracts/schemas/agent-invocation.v1.schema.json
---

# M2C bounded state context specification

## Outcome

An attempt may receive an explicitly selected, bounded view of ExecutionState.
Tenvyr freezes the exact versioned view as immutable attempt data and places the
same envelope in the durable invocation before dispatch. This stage does not
project artifacts and does not write state.

## Repository fit

- `StepAttemptEntity.contextSnapshot` and its nullable JSONB column already exist.
  Reuse them; do not add a snapshot table without new repository evidence.
- `AgentInvocationV1.context` already accepts a JSON map. Reuse it without adding
  a new root protocol field.
- Both official Workers already expose the full invocation to the handler.
- Both attempt creation paths currently set `contextSnapshot: null`.
- `claimRunnableStep` owns the attempt plus DispatchOutbox transaction and locks
  the execution. Projection outside this transaction is a race.
- `PipelineValidationService` reconstructs known step fields, so the new selector
  must be typed, validated, stored in the plan revision, and covered by frozen
  spec hashing.

## Approved vocabulary and wire envelope

`ContextProjection` is declarative pipeline configuration. It authorizes which
execution state keys Tenvyr may expose. It is not the projected data.

`ContextSnapshot` is the immutable, attempt-owned result of applying that
configuration to a particular state version.

Use one reserved Tenvyr-owned member in `AgentInvocationV1.context`:

```json
{
  "tenvyr": {
    "schemaVersion": 1,
    "executionState": {
      "version": 7,
      "values": {
        "approvedBrief": { "artifactId": "..." }
      }
    },
    "artifacts": []
  }
}
```

M2C always emits `artifacts: []` when the Tenvyr envelope exists. M2D extends
that member without changing envelope ownership or version.

The persisted `StepAttempt.contextSnapshot` must contain the exact Tenvyr envelope
value, including `schemaVersion`, state version, selected values, and empty
artifact list. The outbox invocation `context.tenvyr` must deep-equal it.

## Pipeline configuration

Add an optional `contextProjection` to `PipelineStepConfig` with only the minimum
M2C selector:

```yaml
contextProjection:
  stateKeys:
    - approvedBrief
    - review.status
```

Keys are exact top-level ExecutionState keys. A dot is an ordinary key character,
not a path operator. Do not add JSONPath, globbing, expressions, renaming, default
values, transformations, or provider prompt templates.

Semantics:

- absent `contextProjection`: preserve legacy behavior; no Tenvyr context envelope
  and `contextSnapshot` remains null;
- present with an empty `stateKeys`: reject at pipeline validation because it has
  no product meaning;
- duplicate keys: reject, do not silently de-duplicate;
- missing selected state key at claim: deterministic claim failure with a stable
  Tenvyr error code; no attempt and no outbox;
- selected value `null`: include explicit JSON null;
- output order: canonical lexicographic key order independent of input ordering.

## Bounds

- maximum selected state keys: 128;
- key safety and key-length rules: reuse M2B ExecutionState validation;
- complete canonical UTF-8 `context.tenvyr` envelope: at most 65,536 bytes;
- JSON values: reuse M2B JSON cleanliness, finite-number, nesting, and unsafe-key
  rules rather than introduce a second incompatible validator;
- size is measured after the complete envelope is formed, not per selected value.

If the existing M2B state maximum can itself reach 64 KiB, selection still must
fit the complete envelope. The configured key count is not a promise that every
future state version will fit.

## Transaction and determinism invariants

1. Lock the logical step and execution using the existing claim order.
2. Read state, semantic state version, and selected values under that execution
   lock.
3. Build and validate the snapshot inside the claim transaction.
4. Persist attempt, snapshot, and outbox invocation atomically.
5. A forced snapshot or outbox failure leaves none of them authoritative.
6. Dispatch and recovery use the persisted outbox invocation; they never rebuild
   the snapshot from current state.
7. A later retry creates a new attempt and evaluates a new snapshot.
8. Later state mutations never alter an earlier attempt snapshot.
9. Racing a state mutation yields either a complete prior version or complete
   later version, never mixed values/version.

## Deterministic claim failure

Projection validation or materialization failure is not a transport retry and
must not leave a logical step indefinitely READY. Route it through the existing
deterministic step failure/onFailure policy without creating a DispatchOutbox.
Persist enough stable error evidence to diagnose the failure, but never include
selected values in the error or logs.

The implementation plan must inspect the current claim/Engine contract and choose
the smallest existing deterministic failure mechanism. It must not invent a
second scheduler.

## Compatibility and non-goals

- Existing `inputSnapshot`, template resolution, conditions, timeouts, retries,
  and `onFailure` semantics are unchanged.
- Arbitrary user-supplied `AgentInvocation.context` handling outside the reserved
  Tenvyr member is not redesigned.
- No previous result output is implicitly injected.
- No artifact selector, consumption edge, state mutation, MemoryRef, prompt
  construction, replay engine, provider adapter intelligence, or public context
  endpoint is added.
- Historical null snapshots remain null; no backfill invents what old attempts saw.

## Acceptance requirements

M2C is ready for independent review only when executable evidence proves pipeline
validation, canonical selection, complete-envelope bounds, transaction atomicity,
state-race consistency, retry/redelivery semantics, Worker visibility, legacy
compatibility, restart durability, current docs/ledger truth, and the M0/M1/M2A/B
regression gates.
