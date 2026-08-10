---
title: Agent Protocol v1
status: current
audience:
  - developer
last_verified: 2026-08-10
sources:
  - contracts/schemas
  - packages/contracts/src/types.ts
  - packages/contracts/src/http-types.ts
  - packages/contracts/src/validation.ts
  - packages/contracts/src/legacy.ts
  - packages/contracts/test/validation.spec.ts
  - packages/contracts/test/json-numbers.spec.ts
  - services/orchestrator/src/services/agent-event.service.ts
  - services/orchestrator/src/entities/agent-event.entity.ts
  - packages/worker/src/events/event-emitter.ts
---

# Agent Protocol v1

## Decision

Tenvyr uses versioned, runtime-independent JSON contracts at Kafka and HTTP
boundaries. The
canonical draft 2020-12 schemas live in [`contracts/schemas`](../../../contracts/schemas), and
the shared TypeScript implementation lives in
[`packages/contracts`](../../../packages/contracts).

The protocol does not choose a transport. Kafka compatibility identifiers,
agent names, the pipeline DAG, the Java Agent Runner HTTP API, and the database
schema remain unchanged.

## Why versioned contracts

The previous Kafka messages were anonymous object literals owned by each service. That made
payload drift detectable only at runtime and made future HTTP, CLI, SDK, or protocol adapters
depend on Kafka-specific shapes. A schema version, exported TypeScript types, and runtime
validation create one contract that transports can share while legacy Kafka messages are
retired gradually.

## Publish and consume flow

1. The Orchestrator creates the existing persisted step execution and publishes an
   `AgentInvocationV1`. Its persisted UUID becomes `stepExecutionId`; the deterministic
   `<stepExecutionId>:<attempt>` value becomes `invocationId`.
2. `agent-code-reviewer` and `agent-observability` parse a v1 invocation or normalize a
   legacy task before reading business input.
3. Each agent publishes an `AgentResultV1` carrying the invocation, execution, and persisted
   step correlation IDs.
4. The Orchestrator validates the result, resolves `stepExecutionId` back to the current
   persisted step, rejects stale invocation IDs, then maps `succeeded` to `COMPLETED` and all
   other terminal result statuses to `FAILED`.

`AgentEventV1` is the operational-event protocol message: workers emit it as
durable evidence of activity during a run, and the Orchestrator stores and
supervises it. No ordering store, event sourcing, replay, or streaming
migration is part of v1.

## AgentEventV1: operational events

### Canonical shape

`AgentEventV1` shares the correlation fields of the invocation/result pair and
adds event identity, sequence, type, and a JSON-object payload:

```json
{
  "schemaVersion": "1",
  "eventId": "fce595ea-57de-4450-9e15-7170a3a66e5d:1:2",
  "invocationId": "fce595ea-57de-4450-9e15-7170a3a66e5d:1",
  "executionId": "066595ff-4d5e-40e2-87b1-a5ea252f6543",
  "stepExecutionId": "fce595ea-57de-4450-9e15-7170a3a66e5d",
  "sequence": 2,
  "type": "progress",
  "occurredAt": "2026-07-26T00:00:05.000Z",
  "payload": { "percent": 60 },
  "trace": {
    "traceId": "7f3c9a2e",
    "correlationId": "9b1d4f8c"
  },
  "metadata": { "runId": "run-42" }
}
```

Types are `accepted`, `progress`, `log`, `heartbeat`, `artifact`, `completed`,
and `failed`. `payload` is a JSON object; the canonical serialized event body
must not exceed 64 KiB, enforced on the Worker before emission and on the
Orchestrator before persistence.

### Sequence semantics

- `sequence` is the worker-produced logical order within one invocation,
  monotonic from 0.
- `eventId` is deterministic and stable across delivery retries:
  `${invocationId}:${sequence}`.
- Events may arrive out of order, with gaps, or after the terminal
  `AgentResult`. The Orchestrator never reorders, renumbers, or fills gaps.
- Duplicate deliveries are idempotent: `(stepAttemptId, eventId)` is the
  canonical identity and `(stepAttemptId, sequence)` is also unique.
- A different payload for the same `eventId`, or a different `eventId` claiming
  an owned `sequence`, is retained as evidence in `agent_event_conflicts`
  instead of overwriting the canonical row.

### Authority split

`AgentResult` remains the only worker-originated terminal authority.
`AgentEvent` is durable operational evidence: it can project server-received
liveness fields on a non-terminal attempt and prove worker activity
(`DISPATCHED` → `RUNNING`), but it can never terminalize an attempt, change a
LogicalStep outcome, or create a StepAttempt. Late events after a terminal
result remain append-only evidence and never touch liveness columns.

### occurredAt versus receivedAt

`occurredAt` is worker-reported and is audit evidence only — a worker clock can
be skewed or hostile. `receivedAt` is the Tenvyr ingestion time assigned by the
Orchestrator and is the liveness authority for supervision; deadlines are never
computed from worker clocks.

HTTP workers deliver both `AgentResultV1` and `AgentEventV1` through the same
signed callback; Kafka event topics carry canonical `AgentEventV1` only.

HTTP workers wrap `AgentInvocationV1` in `HttpAgentRunRequestV1`, return an
asynchronous `HttpAgentRunAcceptedV1`, and later deliver `AgentResultV1` through
the signed callback. The callback secret never appears in the request body.

## Legacy normalization

New readers continue to accept the exact legacy task and result objects. The complete field
mapping and deterministic compatibility IDs are documented in
[`contracts/README.md`](../../../contracts/README.md). New writers emit only v1.

Legacy invocation IDs are derived solely from `executionId`, `stepId`, and `attempt`.
Legacy results are correlated to the existing step record by `executionId + stepId`; the
Orchestrator then supplies the persisted step UUID to the result normalizer. No normalizer
generates random IDs or invents missing orchestration context.

## Validation and failure handling

`parseAgentInvocation`, `parseAgentResult`, and `parseAgentEvent` validate the canonical
schema and return typed values. Invalid values throw `ContractValidationError` with a
contract name and readable `{ path, message, keyword }` issues; raw Ajv errors never cross
the package boundary.

Kafka consumers catch validation errors and log only the contract, issues, execution ID,
topic/message key where available. They do not log the complete input. Invalid invocations
do not call the runner or publish success. Invalid results do not advance an execution; the
existing step timeout/failure path remains responsible for a missing valid result.

JSON Schema defines the payload shape, while the semantic number policy is
enforced recursively by the contract libraries and Worker boundaries. See
[JSON interoperability](./json-interoperability.md) for the finite-number and
safe-integer requirements that apply to every protocol-v1 JSON value.

## Examples

Successful invocation and result examples are the canonical
[`agent-invocation.v1.json`](../../../contracts/examples/agent-invocation.v1.json) and
[`agent-result.v1.json`](../../../contracts/examples/agent-result.v1.json) files.

A failed result uses the same correlation fields:

```json
{
  "schemaVersion": "1",
  "invocationId": "fce595ea-57de-4450-9e15-7170a3a66e5d:1",
  "executionId": "066595ff-4d5e-40e2-87b1-a5ea252f6543",
  "stepExecutionId": "fce595ea-57de-4450-9e15-7170a3a66e5d",
  "status": "failed",
  "error": {
    "code": "AGENT_EXECUTION_FAILED",
    "message": "Agent Runner returned HTTP 503",
    "retryable": false
  },
  "completedAt": "2026-07-26T00:00:12.000Z"
}
```

## Evolution and compatibility policy

- Add optional fields only when older v1 readers can safely ignore them; extensions belong
  under `metadata` while v1 top-level schemas remain closed.
- A new required field, changed meaning, or removed value requires a new schema version and
  a reader period that accepts both versions.
- Readers accept v1 and legacy; writers emit v1 only.
- Legacy support is deprecated only after production telemetry shows no legacy writers and a
  separately reviewed removal plan has completed.
- No legacy database fields or schemas are removed by this change.
