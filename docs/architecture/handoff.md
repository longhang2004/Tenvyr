---
title: "Portable Handoff"
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-17
sources:
  - services/orchestrator/src/domain/handoff.ts
  - services/orchestrator/src/services/handoff.service.ts
  - services/orchestrator/src/entities/handoff.entity.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/services/execution-capsule.service.ts
---

# Portable Handoff

A bounded cross-runtime continuation primitive: a TERMINAL run can be
continued as a NEW Team Run on a DIFFERENT runtime connection, with a
bounded `HandoffBundleV1` as the initial context and truthful lineage.

It is NOT hidden session migration, chat-history copying, chain-of-thought
migration, or deterministic replay.

## HandoffBundleV1

A bounded, strictly-parsed projection of durable Tenvyr truth (references,
never raw logs):

- schemaVersion, sourceExecutionId, sourceRunId, goal
- source workspace identity (no capture time) + execution-workspace lease
  identity (mode/path/base/state)
- latest plan revision reference (id + planHash, never the plan)
- latest iteration number + latest verifier decision (bounded reason)
- bounded worker outcome summaries of the latest iteration
- selected artifact references
- acceptance evidence (run metadata)
- bounded next-work description (derived from durable wait/decision/
  termination reasons)
- source runtime/model provenance (from frozen attempt efficiency
  evidence — the SOURCE's identity, never rewritten)
- createdAt

The bundle never embeds credentials, runtime session files, hidden
reasoning, arbitrary tool output, or Capsule blobs; it is bounded at
16 KiB and strictly parsed (unknown fields rejected).

## Continuation semantics

`continue-run` (audited, idempotent via `runCommand`):

1. The destination Runtime Target is validated through the existing P2
   authority (`assertExplicitTargetsReady`) BEFORE the command — the
   destination picker is the existing one; no new provider system.
2. The bundle is built from the TERMINAL source run (fail closed with
   `SOURCE_NOT_TERMINAL` otherwise, re-asserted inside the authority
   transaction).
3. A NEW execution/run is created whose goal is the handoff goal and whose
   initial input carries the bounded bundle; iteration 1 starts normally;
   all existing authority (policy, budget, deadline, connection revocation)
   applies to the continuation like any run.
4. The `handoffs` row (unique `(sourceExecutionId, bundleHash)`) is the
   durable lineage; the destination Capsule records it
   (`coordination.run.handoff`).

## Workspace ownership

- Source run must be TERMINAL before its execution workspace can be
  transferred.
- A PRESERVED git-worktree lease transfers under EXCLUSIVE ownership: the
  source lease keeps its identity as `TRANSFERRED` (the source Capsule
  never loses where it executed) and the destination receives a NEW lease
  on the same physical worktree — two runs never share an IN_USE lease;
  a concurrent continuation fails closed (`LEASE_NOT_AVAILABLE`), never a
  false READY.
- Shared mode allocates a fresh shared lease for the destination.
- Uncommitted work is preserved through the transfer — it is never copied
  by pretending HEAD contains it.

## Non-goals

No automatic merge-to-main, no push, no branch deletion, no task-collision
guard, no semantic diff analysis, no file locking, no LLM conflict
prediction.