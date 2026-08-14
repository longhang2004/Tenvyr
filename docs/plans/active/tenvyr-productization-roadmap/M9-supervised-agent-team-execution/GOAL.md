---
title: "M9 DeepSeek Goal: Supervised Agent Team Execution"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/VERIFY.md
---

# M9 Goal Mode

## Objective

Implement the bounded deterministic Coordinator over existing execution primitives.

## Slice order

1. Re-read current engine/PlanPatch/delegation/budget/approval/capsule code. Implement
   pure team config, TaskBatch, Verifier decision, aggregation and bound validators.
2. Add only the minimal run/iteration authority persistence and completion hold.
   Prove migrations, lock order, uniqueness, rollback, restart and 100-way CONTINUE.
3. Integrate configured Planner -> validated batch -> existing PlanPatch plus trusted
   Verifier step. Prove no Planner recursion or partial materialization.
4. Integrate fan-out/fan-in, bounded ContextSnapshot aggregation, Verifier decisions,
   WAIT and exact next-iteration creation with deterministic Workers.
5. Wire current budgets/deadlines/policy/approvals/cancellation/M8 revocation and
   Capsules/replay/comparison. Run adversarial bounds and compatibility.
6. Complete example, current docs/ledger, full VERIFY, implementation report and Sol
   handoff. Do not start M10 before independent closure.

## Rules and stops

One slice, tests, and receipt at a time. Stop if completion semantics require a
broader engine redesign than SPEC, current lock order cannot be preserved, or a
product decision changes failure/WAIT behavior. Never let Planner/Verifier dispatch,
raise hard limits, add Planner work, silently rebase, or bypass current authority.
