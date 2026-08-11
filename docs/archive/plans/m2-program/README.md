---
title: "M2 Remaining Program: Bounded Context, State, Artifacts, and Lineage"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/product/principles.md
  - docs/architecture/control-plane.md
  - docs/architecture/contracts/agent-protocol-v1.md
  - docs/reference/implementation-status.json
  - docs/roadmap/observability-provenance.md
  - docs/archive/plans/2026-08-11-tenvyr-m2a-durable-artifact-references.md
  - docs/archive/plans/2026-08-11-tenvyr-m2b-durable-execution-state.md
---

# M2 completed execution program

This directory preserves the execution package used to implement M2B–M2F
after M2A. The Tech Lead independently verified and closed the program on
2026-08-11. It is historical evidence, not current architecture truth.

## Required reading order

1. [Program architecture specification](01-program-architecture-spec.md)
2. [Master DeepSeek Goal Mode](02-master-deepseek-goal-mode.md)
3. [Global verification and anti-regression contract](03-global-verification-and-anti-regression.md)
4. The current milestone's specification, implementation plan, and
   verification plan
5. The next milestone only after the current milestone gate is green

## Milestone sequence

| Milestone | Outcome                                                            | Specification                                      | Implementation plan                                                    | Verification                                                       |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| M2B       | Durable bounded ExecutionState core                                | [Inherited gate](10-m2b-existing-goal-gate.md)     | [Historical plan](../2026-08-11-tenvyr-m2b-durable-execution-state.md) | [Gate](10-m2b-existing-goal-gate.md)                               |
| M2C       | Immutable per-attempt ContextSnapshot and explicit projection      | [Spec](20-m2c-context-snapshot-spec.md)            | [Plan](21-m2c-context-snapshot-plan.md)                                | [Verification](22-m2c-context-snapshot-verification.md)            |
| M2D       | Artifact projection and attempt-to-artifact lineage                | [Spec](30-m2d-artifact-projection-lineage-spec.md) | [Plan](31-m2d-artifact-projection-lineage-plan.md)                     | [Verification](32-m2d-artifact-projection-lineage-verification.md) |
| M2E       | Controlled state writes from declared result mappings              | [Spec](40-m2e-controlled-state-writes-spec.md)     | [Plan](41-m2e-controlled-state-writes-plan.md)                         | [Verification](42-m2e-controlled-state-writes-verification.md)     |
| M2F       | Cross-milestone durability, scale, security, and closure readiness | [Spec](50-m2f-hardening-closure-spec.md)           | [Plan](51-m2f-hardening-closure-plan.md)                               | [Verification](52-m2f-hardening-closure-verification.md)           |

## Program boundary

The program completes bounded execution context, explicit mutable state,
immutable context snapshots, artifact reference selection, producer and
attempt-exposure lineage, and replay-ready durable facts. It does not implement:

- artifact byte/blob storage or arbitrary URI fetching;
- vector memory, semantic search, RAG, or a long-term memory platform;
- provider prompt construction or provider SDK behavior in the Orchestrator;
- Planner, PlanPatch, budgets, policy, approvals, native subagents, or replay;
- public artifact/state/context APIs before an authentication milestone.

The last point is deliberate: the current Gateway/Orchestrator API is known to
be unauthenticated, and state/artifact/context data may be sensitive.

## Review ownership

DeepSeek left the program ready for review without claiming closure. The Tech
Lead repaired three bounded correctness gaps and recorded the independent
verdict in the [closure review](../../reviews/2026-08-11-m2-independent-closure.md).
