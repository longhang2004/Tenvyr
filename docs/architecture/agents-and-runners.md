---
title: Agents and Runners
status: current
audience:
  - developer
  - operator
last_verified: 2026-07-28
sources:
  - services/agent-code-reviewer/src/kafka.service.ts
  - services/agent-code-reviewer/src/kafka.service.spec.ts
  - services/agent-observability/src/kafka.service.ts
  - services/agent-observability/src/kafka.service.spec.ts
  - services/agent-runner/src/main/java/com/agentweave/runner/controller/RunnerController.java
  - services/agent-runner/src/main/java/com/agentweave/runner/service/LlmService.java
  - services/agent-runner/src/test/java/com/agentweave/runner/controller/RunnerControllerTest.java
  - services/agent-runner/src/test/java/com/agentweave/runner/service/LlmServiceTest.java
---

# Agents and Runners

The current specialized agents use Kafka for orchestration and HTTP for model
execution. They are fixed services, not dynamically registered capabilities.

## Code Reviewer agent

The service consumes `agentweave.agent.code-reviewer.task` with consumer group
`agentweave-reviewer-group`. It accepts a v1 invocation targeted to
`code-reviewer` or a deterministically normalized legacy task. Input is an
object containing code and optional language.

It reads the repository-local `skills/security-review-basic.md` when present,
otherwise uses an embedded minimal security-review rule set. This is one
hard-coded file lookup; the service does not discover or load arbitrary
downloaded community skills. It posts a prompt template and execution context
to the Java Runner, extracts a JSON object when possible, and otherwise wraps
the raw runner text in a fallback finding. It publishes `AgentResultV1` to
`agentweave.agent.code-reviewer.result`.

## Observability agent

The service consumes `agentweave.agent.observability.task` with consumer group
`agentweave-observability-group`. Its input boundary contains logs and review
findings. It reads the fixed repository-local
`skills/observability-guidelines.md` when present, or uses an embedded fallback
guideline. It calls the same Java Runner and publishes `AgentResultV1` to
`agentweave.agent.observability.result` with a health status, analysis, and
estimated latency when parsing succeeds.

Neither specialized agent is an OpenTelemetry collector, trace store, or
production anomaly platform. The “observability” name describes its current
diagnostic prompt, not the roadmap observability architecture.

## Java Agent Runner

The Spring Boot Runner exposes `POST /api/run` with `promptTemplate` and a
context map, plus `/health`. It resolves `{{path}}` placeholders, then selects
the configured provider:

- deterministic local output when `LLM_PROVIDER=mock`;
- OpenAI when `LLM_PROVIDER=openai` and a non-placeholder API key exists;
- Anthropic when selected with a non-placeholder API key;
- Ollama when selected, using its configured local URL.

Unsupported providers and failure modes are rejected. A real provider defaults
to `LLM_FAILURE_MODE=fail`; provider or configuration errors become explicit
agent failures. Only an explicit `LLM_FAILURE_MODE=mock` permits deterministic
fallback, which records the requested provider and `fallbackUsed=true`.

The response includes `provider`, `model`, `fallbackUsed`, and
`usageSource=estimated` metadata alongside estimated prompt/completion/total
token counts. The specialized Kafka agents preserve that metadata under their
result output. When a Kafka template is available, the controller best-effort
publishes token analytics to the compatibility analytics topic; analytics
failure does not fail the run.

## Tests and limitations

The specialized-agent tests prove v1 and legacy consumption, correlated v1
results, invalid-input isolation, safe logging, and provider metadata
propagation. Java tests cover default mock, each provider selection, unsupported
configuration, missing credentials, both failure modes, metadata, and the
absence of credential values in logs. Provider HTTP responses are mocked; live
OpenAI, Anthropic, and Ollama calls are not CI release gates.

The Runner uses approximate token counts, has no model-routing policy engine,
and retains the compatibility Java namespace documented in the
[identity record](../product/identity.md). Provider SDKs do not belong in Worker
core; applications may use the pattern in
[using model providers](../showcase/using-model-providers.md).
