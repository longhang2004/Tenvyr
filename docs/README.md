---
title: Tenvyr Documentation
status: current
audience:
  - developer
  - operator
  - product
last_verified: 2026-08-11
sources:
  - package.json
  - docs/reference/implementation-status.json
---

# Tenvyr Documentation

Use this index after executable sources. Documentation is divided by purpose so
planned or historical material cannot be mistaken for current behavior.

## Source-of-truth hierarchy

1. Executable contracts and schemas.
2. Production code.
3. Executable tests and conformance fixtures.
4. Current architecture and operations documentation.
5. Product decisions.
6. Roadmap documents.
7. Historical plans, specifications, migrations, and decisions.

When these disagree, code, executable contracts, and tests take precedence over
prose. The conflict must still be corrected rather than ignored.

## Current architecture

- [System overview](architecture/overview.md)
- [Control plane](architecture/control-plane.md)
- [Coordinator loop domain](architecture/coordination-loop.md)
- [Operator Workbench](architecture/workbench.md),
  [workspace execution / isolation](architecture/workspace-execution.md),
  the [attention queue](architecture/attention.md), and the
  [portable handoff](architecture/handoff.md)
- Operations: [self-hosted deployment](operations/self-hosted.md), [runbooks](operations/self-hosted-runbooks.md), [supervised coding team runs](operations/supervised-coding-team.md)
- [Agents and runners](architecture/agents-and-runners.md)
- Contracts: [agent protocol v1](architecture/contracts/agent-protocol-v1.md)
  and [JSON interoperability](architecture/contracts/json-interoperability.md)
- Transports: [adapter model](architecture/transports/adapter-model.md),
  [Kafka runtime v1](architecture/transports/kafka-runtime-v1.md), and
  [HTTP adapter v1](architecture/transports/http-agent-adapter-v1.md)
- Executors: [local executor host](architecture/executors/local-executor-host.md),
  [runtime connections](architecture/executors/runtime-connections.md),
  [model sources and runtime targets](architecture/provider-connections.md),
  the [native integration matrix](architecture/executors/native-integrations.md),
  and the
  [invocation efficiency / context projection baseline](architecture/executors/invocation-efficiency.md)
- Workers: [TypeScript](architecture/workers/typescript-worker-sdk.md),
  [Python](architecture/workers/python-worker-sdk.md), and the
  [machine parity ledger](architecture/workers/worker-sdk-parity.json)

## Operations

- [User manual (English)](user-manual.md)
- [Sổ tay người dùng (Tiếng Việt)](user-manual.vi.md)
- [Local development](operations/local-development.md)
- [Configuration reference](operations/configuration.md)
- [Testing and verification](operations/testing-and-verification.md)
- [Package verification](operations/package-verification.md)

## Showcase

- [5–10 minute demo guide](showcase/demo-guide.md)
- [Using model providers](showcase/using-model-providers.md)
- [Portfolio case study](showcase/case-study.md)

## Development and tooling

- [Agent rules](development/agent-rules.md)
- Optional local tooling: [CodeGraph](development/tooling/codegraph.md),
  [agent skills](development/tooling/agent-skills.md),
  [persistent memory](development/tooling/persistent-memory.md), and
  [output compression](development/tooling/output-compression.md)

Developer tooling is not a Tenvyr production runtime feature.

## Product and reference

- [Product principles](product/principles.md)
- [Product identity and publication blockers](product/identity.md)
- [Implementation status](reference/implementation-status.md) and its
  [machine-readable ledger](reference/implementation-status.json)
- [Product-name inventory](reference/product-name-inventory.json)

## Roadmap, plans, and history

- Planned work: [roadmap index](roadmap/README.md), the accepted
  [M8–M11 productization roadmap](plans/active/tenvyr-productization-roadmap/ROADMAP.md),
  its [DeepSeek entrypoint](plans/active/tenvyr-productization-roadmap/DEEPSEEK_LONG_RUN.md),
  the [P2 runtime model sources + model selection slice](plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/GOAL.md),
  the [PP1 coding-agent wedge slice](plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/GOAL.md),
  the [P3 runtime harness optimization + context efficiency slice (implemented; plan archived)](archive/plans/tenvyr-productization-roadmap/P3-runtime-harness-optimization/GOAL.md),
  and the [Product Phase 1 plan](plans/active/supervised-coding-team/PLAN.md)
- The older [observability/provenance roadmap](roadmap/observability-provenance.md)
  is thematic research; current M0–M7 contracts and the accepted roadmap take
  precedence where its assumptions are stale.
- Plan policy: [plan lifecycle](plans/README.md)
- Closed M3–M7 evidence: [independent review](archive/reviews/2026-08-12-m3-m7-independent-closure.md)
  and [historical execution roadmap](archive/plans/tenvyr-roadmap/ROADMAP.md)
- Closed M2 evidence: [independent review](archive/reviews/2026-08-11-m2-independent-closure.md)
  and [historical execution program](archive/plans/m2-program/README.md)
- Open release boundary: the
  [External Production Exposure Gate](archive/plans/tenvyr-roadmap/EXTERNAL_PRODUCTION_EXPOSURE_GATE.md)
- Historical records: [archive policy and index](archive/README.md)

Roadmap entries are not implementation claims. Active accepted plans belong in
`docs/plans/active/`; completed records belong in `docs/archive/`; local scratch
work belongs in ignored `docs/_scratch/`.
