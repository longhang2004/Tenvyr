# TypeScript Worker SDK Design

## Purpose

`@agentweave/worker` is a standalone Node.js runtime harness for HTTP agents. It accepts
canonical `AgentInvocationV1` requests, runs one developer handler, and delivers a canonical
`AgentResultV1` through the existing HMAC callback protocol. It is not an agent framework,
planner, transport router, model client, or durable job system.

## Public API

The package root exports only:

- `createAgentWeaveWorker`
- `defineAgent`
- `AgentExecutionError`
- `AgentWeaveWorker`
- `AgentWeaveWorkerConfig`
- `AgentDefinition`
- `AgentExecutionContext`
- `AgentFailureOptions`
- `AgentExecutionSuccess`
- `WorkerLogger`
- `WorkerAddress`
- `WorkerLifecycleState`

All direct handler returns are raw output. Only `context.success(...)` creates a structured
success; an internal non-enumerable brand removes ambiguity when raw output contains an
`output` property. Parsers support either a function or an object with `parse(value)`.

## Submission and idempotency

The native Node HTTP server exposes `POST /v1/runs`, `GET /health/live`, and
`GET /health/ready`. Submission checks readiness, content type, bearer authentication, body
size, JSON, contracts, target agent, idempotency header, callback key, callback policy,
idempotency, and scheduler capacity in that order.

The fingerprint is SHA-256 over the idempotency key and a deterministic serialization of the
validated request. Object keys are sorted recursively and array order is preserved. Active
records are never evicted. Terminal records expire after the configured TTL. An exact
duplicate returns the original acceptance and never re-executes; a conflict returns `409`.

## Execution

The scheduler is bounded FIFO. The worker sends `202` before scheduling execution. Input is
parsed before the handler, output after it, and all output must be JSON-compatible. Explicit
failure, unexpected failure, timeout, and shutdown produce canonical results which are
validated again before callback delivery.

Timeout and shutdown use cooperative `AbortSignal`. A promise race guarantees one terminal
result; late handler completion is ignored. The SDK does not fabricate usage, upload
artifacts, or log input/output.

## Callback delivery

The SDK serializes each result once, signs the exact UTF-8 bytes, and sends those same bytes.
One delivery ID is stable across retries; every attempt gets a fresh timestamp and signature.
Network errors, timeouts, `408`, `429`, and `5xx` retry. Any `2xx` is delivered. Redirects and
other `4xx` do not retry. Delta-seconds `Retry-After` is honored up to the configured maximum.

Callback URLs require an exact allowed origin, HTTPS unless explicitly relaxed, and no
credentials, query, or fragment. Callback response bodies are bounded. Exhaustion marks the
record `callback_failed`, invokes a safe optional hook, and never reruns the handler.

## Lifecycle

The worker is one-shot. Repeated `start()` while running returns the same address; `stopped`
is terminal; repeated `stop()` is safe. Shutdown disables readiness, closes the listener,
cancels queued runs with `WORKER_SHUTDOWN`, drains active execution/callback work until the
grace deadline, aborts what remains, and clears timers/resources. The SDK installs no process
signal handlers.

## Compatibility and limits

The Worker depends only on `@agentweave/contracts`. Orchestrator HTTP behavior, Kafka,
database schemas, invocation IDs, pipelines, specialized agents, the Java runner, and the
frontend remain unchanged. Idempotency, queue state, and callback delivery are process-local
and are lost on restart. Cancellation is cooperative and there is no persistent outbox,
manual replay, status API, remote cancellation, event stream, or multi-process coordination.
