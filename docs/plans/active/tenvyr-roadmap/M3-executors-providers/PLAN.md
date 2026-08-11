---
title: "M3 Plan: Executor Architecture and Runtime Integration"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/agent-adapters/agent-adapter.types.ts
  - services/orchestrator/src/agent-adapters/agent-adapter.router.ts
  - services/orchestrator/src/agent-adapters/agent-transport-config.service.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - docs/architecture/transports/adapter-model.md
  - docs/reference/implementation-status.json
---

# M3 executor architecture plan

## Product outcome

Tenvyr can select, snapshot, invoke, supervise, cancel where supported, and
attribute results/events to heterogeneous agent runtimes without teaching the
Orchestrator how any model provider formats prompts or tools.

## User/operator value

The same durable pipeline can run existing Kafka/HTTP Workers and additional
trusted runtime classes while retries, deadlines, cancellation, artifacts,
context, events, and results retain one supervisory meaning.

## Existing repository state

- `AgentAdapter` already defines asynchronous `start`, `stop`, `invoke`, result,
  and event delivery for Kafka and HTTP.
- `AgentAdapterRouter` selects transport by exact agent name.
- `AgentTransportConfigService` validates trusted environment configuration and
  resolves secret environment references before use.
- `StepAttempt.executorSnapshot` durably stores `{ agent }` today.
- `DispatchOutboxService` invokes outside a DB transaction and classifies stable
  retryable/non-retryable adapter errors.
- both Worker SDKs expose canonical invocation/result/event behavior.
- local CLI, Codex, Claude runtime, A2A, dynamic executor discovery, and remote
  cancellation are absent; `cli-adapter` is ledger-planned.

## Gaps

- no explicit distinction between logical agent target, executor/runtime, and
  provider;
- no versioned bounded executor descriptor frozen per attempt;
- no executor capability contract for cancellation, action interception, usage,
  or delegation evidence;
- no trusted local-process safety model or crash reconciliation;
- no current official-integration research/compatibility matrix;
- no credential-reference lifecycle beyond current environment-backed HTTP config.

## Dependencies

- independently closed M2 for bounded context/artifact handoff;
- External Production Exposure Gate before public executor or credential admin APIs;
- current official research before Codex, Claude Agent SDK/runtime, A2A, or provider
  compatibility work;
- M4 action policy depends on M3 identifying which executor boundaries can actually
  pause before a side effect.

## Proposed engineering slices

### M3-S1 — executor descriptor and compatibility bridge

Define a bounded, versioned `ExecutorDescriptor`/snapshot and resolver semantics.
Preserve existing `agent` plus Kafka/HTTP pipelines. Keep `AgentAdapter` as the
transport boundary; introduce a higher executor boundary only if a second runtime
lifecycle proves it necessary. Dispatch must consume the attempt-pinned selection;
configuration rotation cannot silently reroute an existing outbox. Legacy
`{ agent }` snapshots require an explicit compatibility reader.

### M3-S2 — capability-aware lifecycle

Normalize dispatch, optional cancellation, events/results, stable error taxonomy,
runtime identity, and capability declarations. Unsupported cancellation remains
explicit; Tenvyr cancellation still wins and late results remain rejected.

### M3-S3 — trusted local process/generic CLI executor

Add one bounded non-network executor from trusted operator configuration. Prefer a
separate executor host/sidecar or Worker application over arbitrary process spawning
inside Orchestrator core. Require fixed executable/argv, no shell, controlled working
directory/environment/secret refs, bounded stdin/stdout/stderr, process-group
deadline/cancellation, canonical result materialization, restart/orphan policy, and
sandbox-profile reference. This slice remains local/operator-only while the exposure
gate is open.

### M3-S4 — native/remote integration research and adapters

Research current official Codex, Claude Agent SDK/runtime, and A2A mechanisms.
Implement only supported, auditable integration modes using documented auth and
lifecycle APIs. Each adapter gets a compatibility matrix and can be independently
deferred if official capability or credentials are unavailable.

### M3-S5 — provider-neutral runtime examples and closure

Prove OpenAI, OpenAI-compatible/DeepSeek, and Anthropic remain Worker/runtime
configuration concerns. Use mocks/conformance by default; never add provider SDKs
to Orchestrator or Worker core. Explicitly decide whether accepted Worker
responsibility may remain process-local or requires a durable Worker queue,
idempotency store, and callback outbox before M3 closure; do not overclaim durability.
Close cross-executor parity and failure behavior.

## Risks

- arbitrary command execution or shell injection;
- secrets in pipeline definitions, snapshots, logs, process arguments, or exports;
- executor impersonation and result/event correlation confusion;
- orphaned processes after crash and false cancellation claims;
- provider/runtime API drift and unsupported session scraping;
- capability overclaim for opaque runtimes;
- restart/redelivery launching duplicate local work;
- schema/API churn from premature executor/provider registries.

## Explicit non-goals

- no LiteLLM/model router, prompt formatter, provider fallback, model registry, or
  billing proxy in Orchestrator;
- no scraping/impersonating interactive user sessions;
- no public executor registry/admin UI while exposure gate is open;
- no M4 policy engine, M5 Planner, M6 supervised delegation, or M7 replay;
- no promise that Tenvyr can cancel or inspect actions hidden inside opaque runtimes.

## Decisions requiring PO/BA input

- which native integrations are mandatory for M3 closure versus separately
  shippable adapters;
- whether trusted local process execution is an acceptable initial deployment
  capability and which sandbox platforms are supported;
- credential storage/rotation product direction beyond environment secret refs;
- whether executor configuration is deployment-only or later user/project-managed.

## Closure definition

Sol may close M3 only when existing Kafka/HTTP behavior is preserved, the executor
descriptor/capability semantics are durable and bounded, at least one approved new
executor path is crash/cancel/security verified, supported native integrations have
official-source evidence, credentials never enter reusable definitions/evidence,
and the full [M3 verification contract](VERIFY.md) passes.

# Milestone handoff

## What was delivered

## User/operator value

## How it works

## Guarantees

## Known limitations

## Architecture decisions

## What this unlocks

## Verification summary

## Recommended next milestone
