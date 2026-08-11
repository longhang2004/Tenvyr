---
title: "M2B Existing Goal Handoff and Gate"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/2026-08-11-tenvyr-m2b-durable-execution-state.md
  - services/orchestrator/src/domain/execution-state.ts
  - services/orchestrator/src/services/execution-state.service.ts
  - services/orchestrator/src/database/migrations/1722270003000-MilestoneTwoExecutionState.ts
---

# M2B existing goal handoff and gate

M2B began from the earlier single-slice DeepSeek prompt before this program
package was authored. Do not restart or redesign it.

## Required action

1. Read the existing active M2B plan and inspect its current implementation.
2. Finish any incomplete checkpoint from that plan.
3. Run every validation command recorded in that plan, including two
   sequential real-PostgreSQL runs.
4. Perform the global anti-regression checks relevant to M2B.
5. Write the milestone receipt under ignored
   `docs/_scratch/m2-program/m2b-receipt.md`, then continue to M2C.

## Additional inheritance tests

Before M2C starts, explicitly prove:

- `AgentResultV1.output` and descriptors never enter ExecutionState;
- `AgentInvocationV1.context` is unchanged;
- a 100-way same-version contention has exactly one winner for five rounds;
- no-op mutations do not change semantic version, row version, or timestamp;
- terminal executions reject mutation;
- the migration preserves M2A tables and rows;
- the active M2B plan remains in progress for Tech Lead review.

## Gate

M2C may start only if M2B is internally clean. If M2B has an unresolved
load-bearing failure, DeepSeek must repair it within M2B scope and rerun the
gate. It must not paper over the failure in later context code.
