---
title: Kafka Runtime v1
status: current
audience:
  - developer
  - operator
last_verified: 2026-07-28
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
---

# Kafka Runtime v1

Kafka is the default transport for agents without an exact HTTP mapping. The
following identifiers are preserved protocol/runtime compatibility values, not
the active product brand:

```text
agentweave.agent.<agent>.task
agentweave.agent.<agent>.result
```

The Orchestrator publishes task messages with `executionId` as the Kafka key.
The code-reviewer and observability services publish result messages with the
same key. Their consumer group IDs remain
`agentweave-reviewer-group` and `agentweave-observability-group`.

## Dispatch and result flow

`KafkaAgentAdapter.invoke` validates `AgentInvocationV1`, serializes it once
with `JSON.stringify`, and publishes to the target agent's task topic. The
receipt contains the invocation ID, dispatch time, and message key; it is not a
pipeline state transition.

At startup the adapter subscribes to result topics derived from
`ORCHESTRATOR_AGENT_NAMES` plus explicit `ORCHESTRATOR_RESULT_TOPICS`. V1
results are validated directly. A legacy result first resolves its persisted
step execution and then receives deterministic correlation IDs before v1
validation. Only scalar topic, key, partition, and offset metadata crosses the
adapter boundary; raw Kafka records do not.

The specialized agents accept either v1 invocation messages or deterministic
legacy normalization, call the Java Runner over HTTP, and emit only
`AgentResultV1`. Invalid invocations do not call the runner or publish success.

## Retry and error ownership

KafkaJS retains its configured producer behavior. `KafkaAgentAdapter` adds no
application retry loop and does not fall back to HTTP. Serialization failures
are non-retryable adapter errors; publish, connect, and handler failures are
reported as retryable adapter errors. `EngineService` owns step retry policy,
timeouts, stale attempts, and DAG progression.

## Compatibility limits

Topic names, group IDs, Java package namespace, and database identifiers are
unchanged. There is no protocol-v1 topic rename, durable application outbox,
event stream, or multi-transport failover.
