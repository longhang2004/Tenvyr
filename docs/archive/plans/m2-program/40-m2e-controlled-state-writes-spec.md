---
title: "M2E Specification: Controlled Result-to-State Writes"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/domain/execution-state.ts
  - services/orchestrator/src/services/execution-state.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/domain/pipeline-definition.ts
  - contracts/schemas/agent-result.v1.schema.json
---

# M2E controlled state writes specification

## Outcome

A pipeline may explicitly authorize a successful step result to copy a bounded
set of selected JSON values into ExecutionState. Authority belongs to the frozen
pipeline definition and canonical ResultInbox transaction—not to an agent-supplied
patch or metadata field.

This preserves Agent Protocol v1: no `statePatch` field is added to
`AgentResultV1`, whose root schema is closed.

## Declarative mapping

Add an optional `stateWrites` array to `PipelineStepConfig`:

```yaml
stateWrites:
  - key: approvedBrief
    fromOutput: /brief
  - key: review.status
    fromOutput: /decision/status
```

Rules:

- `key` is an exact top-level ExecutionState key and follows M2B key safety/length
  rules. Dots are ordinary characters.
- `fromOutput` is a restricted RFC 6901 JSON Pointer into `AgentResultV1.output`.
- Pointer must start with `/`; the empty pointer, URI-fragment form, wildcards,
  filters, recursive descent, expressions, and `-` array append token are rejected.
- Decode only RFC 6901 `~0` and `~1`; reject invalid escape sequences.
- Array index tokens are canonical non-negative base-10 integers without leading
  zeros except `0`.
- Every mapping is required. A missing pointer or non-JSON selected value is a
  deterministic post-result mapping failure.
- Empty arrays, duplicate target keys, duplicate mappings, unknown fields, unsafe
  keys, too many mappings, and malformed pointers are rejected at pipeline ingress.
- Maximum mappings per step: 128. The produced patch/final state retain all M2B
  operation, key, canonical UTF-8, nesting, and 64 KiB final-state limits.

Do not add transformations, conditionals, templating, defaults, merging,
arithmetic, JSONPath, or provider-specific parsing.

## Static write-conflict rule

At pipeline validation, reject two steps that may run concurrently when their
`stateWrites` target the same key. Two writers to the same key are allowed only
when the pipeline DAG proves one is transitively ordered before the other.
Disjoint concurrent writes remain allowed and commute under the execution row lock.

This is a pipeline-definition error, not a runtime race policy. Reuse existing DAG
reachability/validation data; do not build a Planner or dynamic dependency system.

## Result authority and disposition

Apply mappings only for the first canonical authoritative result whose status is
`succeeded`. Failed, cancelled, timed-out, ignored, duplicate, conflicting, and
late results write no state.

For a successful result with `stateWrites`:

1. Resolve every pointer from the canonical output.
2. Build one bounded patch and validate it with M2B rules.
3. Under the already-held execution lock, apply the patch to current state.
4. A semantic no-op does not increment `executionStateVersion` or update its
   timestamp.
5. A real change increments the semantic version exactly once.

Mapping failure semantics are deliberate:

- preserve the canonical result payload as evidence;
- apply no state keys at all;
- mark the attempt/logical step as a deterministic Tenvyr postcondition failure
  and follow existing retry/`onFailure` policy;
- make the ResultInbox terminal/applied so transport redelivery cannot poison-loop;
- use a stable error code without embedding output/state values;
- preserve M2A artifact registration from the canonical result in the same commit.

If the current state machine cannot represent this exact outcome, stop for Tech
Lead review rather than retry the inbox forever or pretend the agent succeeded.

## Atomic transaction

Integrate inside `ResultInboxService.apply`, which already owns canonical result
identity and locks StepAttempt -> ResultInbox -> LogicalStep -> Execution.

Do not call standalone `ExecutionStateService.mutate` from inside that transaction.
Reuse pure validation/application functions with the current EntityManager and
already-locked Execution entity.

The following commit or roll back together:

- canonical ResultInbox disposition/evidence;
- attempt, logical-step, and execution transitions;
- M2A artifact registration;
- ExecutionState value/version/timestamp change or no-op decision;
- controlled-write provenance evidence.

Database or provenance failure leaves the inbox safely retryable and none of the
authoritative effects partially committed.

## Controlled-write provenance

Persist one append-only evidence row for each canonical successful result that
has configured state writes, including:

- Tenvyr UUID;
- execution, StepAttempt, and ResultInbox identities;
- prior and resulting semantic state versions;
- disposition: `applied`, `noop`, or `rejected`;
- canonical mapping/patch hash when materialization succeeded;
- stable rejection code when it failed;
- created timestamp;
- unique ResultInbox identity so duplicate delivery cannot create a second row.

Do not store full prior/new state copies in the evidence row. Canonical result
output plus frozen step configuration remains source evidence. Document that this
is mutation provenance, not a complete replayable state history—M2B's pre-existing
internal mutation service is not retroactively backfilled.

## Concurrency

- Disjoint concurrent result writes serialize under the execution lock and both
  survive regardless of completion order.
- Same-key unordered writers cannot exist in a valid pipeline.
- Ordered same-key writers apply in dependency order because the later step cannot
  become runnable before its dependency succeeds.
- External/internal M2B mutations racing a result are serialized by the same row
  lock; controlled mappings apply to the then-current state without a torn merge.
- Result-versus-cancel obeys the existing terminal authority: cancellation cannot
  be resurrected and a late result writes nothing.

## Compatibility and non-goals

- A step without `stateWrites` follows byte-for-byte current result/state behavior.
- Existing `AgentResultV1.output` remains an output payload; only declared pointers
  are copied. The full output never enters state.
- No new result root field, metadata authority, public state mutation endpoint,
  arbitrary agent patch, provider parsing, memory/RAG, Planner, budget, approval,
  or replay behavior.

## Acceptance requirements

M2E is review-ready only after tests prove pointer correctness, DAG conflict
validation, bounds, canonical-result authority, deterministic mapping failure,
atomic state/artifact/result/provenance behavior, no-op version semantics,
duplicate/cancel/concurrency/restart safety, protocol compatibility, and all prior
milestone regressions.
