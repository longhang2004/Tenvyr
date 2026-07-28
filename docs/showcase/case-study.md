---
title: Tenvyr v0.1.0 Case Study
status: current
audience:
  - product
  - developer
last_verified: 2026-07-28
sources:
  - docs/architecture/overview.md
  - docs/architecture/control-plane.md
  - docs/reference/implementation-status.json
---

# Tenvyr v0.1.0 case study

## Product problem

Agent frameworks solve reasoning and tool use, but a multi-runtime product also
needs external supervision: when a step runs, which transport carries it, how
long it may run, whether it retries, and what durable record explains the final
outcome. Embedding all of that in each agent makes behavior inconsistent and
hard to audit.

Tenvyr separates those responsibilities. Native subagents still decompose and
reason; Tenvyr supervises their containing process as a persisted workflow step.

## Modular control plane and isolated Workers

The Gateway exposes a small HTTP/WebSocket surface. The Orchestrator persists
pipelines and executions, dispatches work, and correlates results. Agents run
outside it, either as Kafka-specialized services or isolated HTTP Workers. The
same versioned invocation and result contracts cross Python, TypeScript, and
Java-backed paths.

This boundary keeps model providers and agent frameworks out of core. A Worker
can call OpenAI, Anthropic, Ollama, a local model, or native subagents without a
control-plane schema change.

## HTTP and Kafka trade-off

Kafka fits the existing long-running specialized agents and decouples dispatch
from consumption, but it carries deployment and compatibility overhead. HTTP
Workers are easier to isolate and embed in application runtimes, but require
careful callback authentication, replay protection, timeouts, and correlation.
v0.1.0 keeps both instead of forcing a migration for showcase simplicity.

## Contracts and callback security

JSON schemas define strict `AgentInvocationV1` and `AgentResultV1` envelopes.
HTTP callbacks use HMAC signatures over a canonical payload with key ID,
timestamp, and delivery ID. Exact callback origins, bounded skew, replay checks,
and size limits form the trust boundary. Compatibility identifiers remain fixed
because renaming a wire protocol is a migration, not cosmetic cleanup.

## Cross-language lessons

The Python and TypeScript runtimes exposed edge cases that single-language tests
miss: JSON integer safety, canonical serialization, retry timing, callback
delivery, cancellation semantics, and package-resource loading. Shared fixtures
and real loopback tests were more valuable than duplicating every unit test.

The project initially accumulated too many overlapping checks. The practical
lesson was to keep one authoritative gate per behavior, reserve stress/lifecycle
suites for their distinct failure modes, and report environment-specific gates
instead of treating one aggregate command as universal proof.

## Scope decisions

The release deliberately builds the smallest end-to-end proof: persisted
workflow, two transports, isolated Workers, explicit provider behavior, and an
inspectable offline demo. It intentionally does not build a universal gateway,
model router, capability registry, policy engine, artifact store, durable
outbox, OpenTelemetry stack, framework adapters, or protocol v2.

That restraint keeps the portfolio claim concrete: Tenvyr supervises agent
execution; it does not pretend to own agent intelligence.
