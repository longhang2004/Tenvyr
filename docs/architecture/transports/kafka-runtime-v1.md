---
title: Kafka Runtime v1
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-10
sources:
  - services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts
  - services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts
  - services/orchestrator/src/services/kafka.service.ts
  - services/agent-code-reviewer/src/kafka.service.ts
  - services/agent-code-reviewer/src/kafka.service.spec.ts
  - services/agent-observability/src/kafka.service.ts
  - services/agent-observability/src/kafka.service.spec.ts
  - packages/contracts/src/legacy.ts
  - packages/contracts/test/legacy.spec.ts
  - services/orchestrator/src/services/agent-event.service.ts
---

# Kafka Runtime v1

Kafka is the default transport for agents without an exact HTTP mapping. The
following identifiers are preserved protocol/runtime compatibility values, not
the active product brand:

```text
agentweave.agent.<agent>.task
agentweave.agent.<agent>.result
agentweave.agent.<agent>.event
```

The Orchestrator publishes task messages with `executionId` as the Kafka key.
The code-reviewer and observability services publish result messages with the
same key. Their consumer group IDs remain
`agentweave-reviewer-group` and `agentweave-observability-group`.

## Dispatch, result, and event flow

`KafkaAgentAdapter.invoke` validates `AgentInvocationV1`, serializes it once
with `JSON.stringify`, and publishes to the target agent's task topic. The
receipt contains the invocation ID, dispatch time, and message key; it is not a
pipeline state transition.

At startup the adapter subscribes to result topics derived from
`ORCHESTRATOR_AGENT_NAMES` plus explicit `ORCHESTRATOR_RESULT_TOPICS`, and to
event topics derived from the same agent names plus explicit
`ORCHESTRATOR_EVENT_TOPICS` (`agentweave.agent.<agent>.event` is the
compatibility wire identifier, consistent with the task/result convention).
V1 results are validated directly. A legacy result first resolves its persisted
step execution and then receives deterministic correlation IDs before v1
validation. Only scalar topic, key, partition, and offset metadata crosses the
adapter boundary; raw Kafka records do not.

Event topics ingest ONLY canonical `AgentEventV1` — there is no legacy event
normalization. A message that fails canonical validation is a poison record:
it is logged (contract, issues, and identifiers only) and acknowledged so it
cannot wedge the consumer. A retryable application failure (the event handler
rejected the message) escapes the consumer callback so KafkaJS redelivers it;
durable PostgreSQL deduplication keeps redelivery idempotent. Result topics
keep the existing behavior, including legacy result normalization, unchanged.

The specialized agents accept either v1 invocation messages or deterministic
legacy normalization, call the Java Runner over HTTP, and emit only
`AgentResultV1`. Invalid invocations do not call the runner or publish success.

## Retry and error ownership

KafkaJS retains its configured producer behavior. `KafkaAgentAdapter` adds no
application retry loop and does not fall back to HTTP. Serialization failures
are non-retryable adapter errors; publish, connect, and handler failures are
reported as retryable adapter errors, so retryable result/event application
failures escape the consumer callback and are redelivered by KafkaJS.
Non-retryable failures — invalid schema, unreadable JSON, poison records — are
logged and acknowledged. `EngineService` owns step retry policy, timeouts,
stale attempts, and DAG progression.

## Compatibility limits

Topic names, group IDs, Java package namespace, and database identifiers are
unchanged. There is no protocol-v1 topic rename, durable application outbox,
event stream, or multi-transport failover. Event topics add a canonical
`AgentEventV1` consumer only; they do not change task or result behavior.
