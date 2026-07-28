---
title: Control Plane
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - services/orchestrator/src/services/engine.service.ts
  - services/orchestrator/src/services/agent-result.service.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/pipeline.service.ts
  - services/orchestrator/src/services/engine.service.spec.ts
  - services/orchestrator/src/services/agent-result.service.spec.ts
  - services/gateway/src/app.controller.ts
  - services/gateway/src/socket.gateway.ts
---

# Control Plane

The Orchestrator is the execution authority. It persists pipelines,
executions, and step executions, resolves dependency and condition state, and
delegates only transport work through `AgentAdapter`.

## Pipeline execution

`EngineService.startExecution` loads a pipeline, creates an execution, marks it
`RUNNING`, and triggers initial steps with no dependencies. For each step it:

1. resolves templates from pipeline input and completed step state;
2. creates a persisted step execution and marks it `RUNNING`;
3. creates and validates an `AgentInvocationV1` with deterministic
   `<stepExecutionId>:<attempt>` identity;
4. invokes `AgentAdapter` asynchronously;
5. schedules the configured local step timeout.

The dispatch receipt is diagnostic only and does not complete or advance a
step. A dispatch failure enters the same step-failure path as an agent failure.

## Result flow and correlation

`AgentResultService` resolves `stepExecutionId`, verifies the execution and
current invocation identity, then maps `succeeded` to `COMPLETED`. `failed`,
`cancelled`, and `timed_out` all enter the existing `FAILED` transition. It
passes the transition to `EngineService`, which rejects unknown steps, stale
attempts, and duplicate terminal updates.

After a terminal step update, the engine evaluates dependent steps. A
dependency is resolved by `COMPLETED` or `SKIPPED`, or by `FAILED` only when
that dependency uses `onFailure: continue`. When every configured step is
terminal, the execution becomes `COMPLETED` with outputs keyed by step ID.

## Failure policies

- `retry` creates another step attempt until `1 + retries` is exhausted.
- `continue` permits downstream dependency evaluation after failure.
- `stop`, the default, marks the execution `FAILED`.
- Input-template failure and transport dispatch failure also enter this policy
  path.
- A configured timeout fails only the still-running matching attempt.

Conditions and templates use current in-process evaluation in `EngineService`;
there is no separate sandboxed policy engine.

## Execution updates

After material state changes, the Orchestrator posts only the execution ID to
the Gateway webhook. The Gateway fetches the full current execution from the
Orchestrator and emits `execution-update` through Socket.IO. Gateway delivery
failure is logged and does not roll back execution state. The frontend also
polls a selected running execution as a fallback.

## Durability boundary

Pipeline, execution, and step-execution entities are database-backed. Adapter
dispatch, HTTP callback replay entries, Gateway notifications, and Worker
queues/idempotency/callback state are not a durable outbox. A process or broker
failure can therefore require the existing timeout/retry behavior; this system
does not claim exactly-once end-to-end delivery.
