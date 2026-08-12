---
title: Implementation Status
status: current
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/reference/implementation-status.json
  - services
  - packages
  - contracts
---

# Implementation status

This is the human-readable summary of current repository behavior. The
[machine-readable ledger](implementation-status.json) is authoritative for the
exact source, test, documentation, and limitation paths of every capability.
Historical plans and implementation reports are evidence, not current API
contracts.

## Implemented internal capabilities

| Capability                                                | Status      | Current boundary                                                                              |
| --------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| Contracts v1, JSON numeric interoperability               | implemented | Schema version 1; post-v1 negotiation is not implemented                                      |
| Kafka and HTTP agent adapters                             | implemented | HTTP callback replay/dispatch state remains process-local                                     |
| TypeScript and Python Worker SDKs                         | implemented | Runtime queues/idempotency are process-local; Python cancellation is cooperative              |
| Java runner and example agents                            | implemented | Example/runtime packages, not a general framework integration layer                           |
| Gateway, frontend, readiness, showcase                    | implemented | General external APIs remain behind the open production-exposure gate                         |
| AgentEvents and deterministic supervision                 | implemented | Events are evidence/liveness input, never execution authority                                 |
| Executor descriptors and local executor host              | implemented | Host is trusted-code-only, bounded process execution; it is not a sandbox                     |
| Budget ledger and hierarchy                               | implemented | Budgets are opt-in; operator adjustments are not idempotency-keyed                            |
| Policy decisions, approvals, and WAITING                  | implemented | Internal authority services; no public approval administration API                            |
| PlanPatch, proposals, policy, and planner trigger         | implemented | Restricted additive/replacement patch model; service-level activation                         |
| Observed and supervised delegation                        | implemented | Observed data is an assertion; supervised requests create bounded child executions            |
| Execution Capsule, export, replay, comparison, provenance | implemented | Service-level only; replay is a new execution and does not promise deterministic model output |
| W3C context propagation                                   | implemented | Outbound `traceparent` only; no trusted inbound parentage or `tracestate`                     |
| Product identity and package verification                 | implemented | Publication remains separately blocked                                                        |

## Partial capabilities

| Capability                   | Status  | Current boundary                                                                                                                               |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator pipeline engine | partial | Durable internal M0–M7 authority exists; public authn/authz, ownership, and multi-tenant exposure do not                                       |
| OpenTelemetry                | partial | Bounded non-authoritative OTLP-shaped mapper exists; no wired exporter or real timing capture                                                  |
| Artifact store               | partial | Immutable reference identity, producer/exposure lineage, and bounded projection; no byte ownership, URI verification, retention, or public API |
| Execution state              | partial | Bounded versioned mutable state, controlled writes, and snapshot projection; no event-sourced history, public API, or historical state replay  |

## Planned or blocked capabilities

| Capability             | Status  | Current boundary                                                        |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| CLI adapter            | planned | Trusted local execution exists, but no dedicated CLI transport contract |
| Framework integrations | planned | No LangGraph/provider-specific helper packages                          |
| Durable Worker outbox  | planned | Worker runtime state remains process-local                              |
| Public package release | blocked | Registry, legal, repository, security, and approval gates remain open   |

## Closure records

- [M2 independent closure](../archive/reviews/2026-08-11-m2-independent-closure.md)
- [M3–M7 independent closure](../archive/reviews/2026-08-12-m3-m7-independent-closure.md)
- [Current control-plane architecture](../architecture/control-plane.md)

The complete numbered M0–M7 roadmap is closed. That is an internal technical
milestone claim, not an external production-readiness or public-release claim.
