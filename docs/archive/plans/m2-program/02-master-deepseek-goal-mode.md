---
title: "DeepSeek Goal Mode: Complete the Remaining M2 Program"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/01-program-architecture-spec.md
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - docs/operations/testing-and-verification.md
  - docs/development/agent-rules.md
---

# DeepSeek Goal Mode master prompt

Copy everything in the block below into one DeepSeek Goal Mode run. The stage
documents are intentionally self-contained so the run can survive context
compaction and continue for several hours without asking the PO/BA to restate
the architecture.

```text
You are the implementation engineer for Tenvyr Milestone 2. Work continuously
through the remaining accepted M2 program in the repository. This is a long-run
goal containing multiple gated engineering stages. Do not stop merely because
one stage is complete. Continue to the next stage only when the current stage's
specified gates pass and its receipt is complete.

Repository and authority
========================

1. Work in the current Tenvyr repository. Treat Tenvyr as the product name and
   current identity regardless of the local directory name.
2. Read the repository's AGENTS.md and all applicable local instructions first.
3. Current contracts, production code, migrations, and executable tests outrank
   prose. Current architecture docs outrank plans. Plans describe intended work,
   not already-shipped behavior.
4. Preserve every pre-existing user change. The working tree may be dirty and
   M2B may already be partially or fully implemented. Inspect it; do not reset,
   discard, overwrite, or restart working code.
5. Do not commit, push, create a PR, archive plans, or claim Tech Lead approval.
   The Tech Lead will independently review the entire accumulated program later.

Required durable reading order
==============================

Read these files in full before production edits:

1. docs/archive/plans/m2-program/README.md
2. docs/archive/plans/m2-program/01-program-architecture-spec.md
3. docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
4. docs/archive/plans/m2-program/10-m2b-existing-goal-gate.md
5. docs/archive/plans/2026-08-11-tenvyr-m2b-durable-execution-state.md

At each later stage, read that stage's specification, plan, and verification
file in numerical order. Re-read the shared architecture and verification files
after any context compaction or when resuming the goal.

Stage sequence
==============

Stage 0 — inherit and finish M2B:
- docs/archive/plans/m2-program/10-m2b-existing-goal-gate.md
- docs/archive/plans/2026-08-11-tenvyr-m2b-durable-execution-state.md

Stage 1 — M2C bounded state ContextSnapshot:
- docs/archive/plans/m2-program/20-m2c-context-snapshot-spec.md
- docs/archive/plans/m2-program/21-m2c-context-snapshot-plan.md
- docs/archive/plans/m2-program/22-m2c-context-snapshot-verification.md

Stage 2 — M2D artifact projection and lineage:
- docs/archive/plans/m2-program/30-m2d-artifact-projection-lineage-spec.md
- docs/archive/plans/m2-program/31-m2d-artifact-projection-lineage-plan.md
- docs/archive/plans/m2-program/32-m2d-artifact-projection-lineage-verification.md

Stage 3 — M2E controlled state writes:
- docs/archive/plans/m2-program/40-m2e-controlled-state-writes-spec.md
- docs/archive/plans/m2-program/41-m2e-controlled-state-writes-plan.md
- docs/archive/plans/m2-program/42-m2e-controlled-state-writes-verification.md

Stage 4 — M2F program hardening and closure readiness:
- docs/archive/plans/m2-program/50-m2f-hardening-closure-spec.md
- docs/archive/plans/m2-program/51-m2f-hardening-closure-plan.md
- docs/archive/plans/m2-program/52-m2f-hardening-closure-verification.md

Continuous stage loop
=====================

For every stage, execute this loop without skipping steps:

A. Establish baseline
- Record `git status --short` and the exact current migration order.
- Inspect current sources and tests named by the stage files.
- Identify which requirements already exist and reuse them.
- Write a baseline section in the stage receipt. Never assume a prior stage's
  implementation from prose alone.

B. Implement the smallest complete stage
- Follow the specification invariants and the implementation plan.
- Prefer existing entities, transaction owners, validators, test harnesses, and
  standard-library facilities. Add no speculative abstraction or dependency.
- Keep contracts framework-neutral. Provider-specific prompt construction,
  reasoning, and SDK intelligence stay outside the Orchestrator.
- Add or change a migration only when durable schema truth requires it. Never
  create an empty migration. Preserve monotonic registration order.
- Treat Worker input, result payloads, artifact descriptors, URIs, metadata,
  state keys, and pipeline definitions as untrusted input.

C. Review before testing
- Inspect every changed file and every caller of a changed shared function.
- Check transaction lock order, idempotency, cancellation, duplicate delivery,
  restart recovery, and migration upgrade behavior.
- Search for accidental artifact bytes or unbounded prior output copied into
  ExecutionState, ContextSnapshot, logs, events, or invocation context.
- Check that no provider, RAG, semantic memory, Planner, budget, subagent,
  approval, replay executor, public artifact API, or URI-fetching concern entered
  the stage.

D. Run the stage verification file
- Run every required focused, PostgreSQL, contract, SDK, documentation, identity,
  formatting, and package gate named by the stage.
- Use only a disposable PostgreSQL database named `tenvyr_m2_test`. Never point
  destructive integration setup at postgres, template0, template1, or any
  configured application database.
- Run the real PostgreSQL suite twice sequentially after the first clean pass.
- If a gate fails, diagnose the root cause, repair it within the current stage,
  and rerun the affected gate plus any downstream gate invalidated by the repair.
- Do not waive a failing gate as flaky. Either make the evidence reliable or
  record a genuine external blocker and stop.

E. Produce a durable review receipt
- Create or update the ignored scratch file:
  docs/_scratch/m2-program/<stage>-receipt.md
- Include: starting git status, requirement checklist, architecture decisions,
  file inventory, migrations, tests added, exact commands, exit codes and test
  counts, PostgreSQL database name, failure-injection results, known limitations,
  and final git status.
- Record failures encountered and the fixes, not only the final green run.
- Do not label the stage `verified`, `closed`, or `SAFE TO CLOSE`. Use the exact
  phrase `READY FOR INDEPENDENT TECH LEAD REVIEW` only when all specified gates
  pass.

F. Decide whether to continue
- Continue immediately to the next stage only if the stage is ready for review.
- Stop if the stage exposes a choice that contradicts the approved specification,
  requires a public protocol version break, requires artifact byte ownership,
  or requires auth/tenant policy that the program does not define.
- A difficult implementation, a long test run, or one repair cycle is not a
  reason to stop.

Non-negotiable program invariants
=================================

1. ExecutionState is small, structured, versioned mutable execution data.
2. ContextSnapshot is immutable, attempt-owned, bounded, and exactly matches the
   Tenvyr context envelope durably placed in that attempt's DispatchOutbox.
3. Context projection is deny-by-default. No implicit all-state, all-artifact,
   or all-prior-output injection exists.
4. Artifact is a Tenvyr-owned immutable reference identity with producer
   provenance. Tenvyr does not fetch its URI or claim external bytes are immutable.
5. An artifact projection edge proves that Tenvyr exposed the reference to an
   attempt; it does not claim the agent semantically used the artifact.
6. State writes are pipeline-authorized mappings from a successful canonical
   AgentResultV1.output. Do not add `statePatch` to AgentResultV1 and do not treat
   result metadata as state authority.
7. Snapshot/attempt/outbox and artifact exposure edges commit atomically before
   dispatch. Result application/artifact registration/state writes commit
   atomically under the existing canonical ResultInbox transaction.
8. Duplicate, conflicting, ignored, cancelled, timed-out, and late results never
   apply state twice or invent lineage.
9. Persisted attempt context is never recomputed during dispatch recovery.
10. M0, M1, and M2A authority and deterministic supervision remain intact.

Compatibility rules
===================

- An old pipeline without contextProjection or stateWrites retains its current
  behavior and wire payload.
- Reuse the existing optional AgentInvocationV1.context field only for a reserved,
  versioned Tenvyr envelope. Do not tighten the entire public free-form context
  contract incompatibly.
- Keep inputSnapshot and existing pipeline input/template semantics separate.
- Do not remove legacy null contextSnapshot rows or invent historical backfill.
- If any canonical schema changes, update TypeScript types, JSON schema, semantic
  schema hashes, tracked Python schema copies, conformance fixtures, package packs,
  and current documentation deliberately.

Migration and transaction rules
===============================

- Current expected order begins M0 0000, M1 1000, M2A 2000, M2B 3000.
- New migrations start at 1722270004000 and increase monotonically. Inspect the
  live list before choosing each number because another actor may have added one.
- Migrations are additive, repeat-safe where repository conventions require it,
  preserve existing rows, and do not fabricate snapshots or exposure history.
- The authoritative attempt claim seam is ExecutionService.claimRunnableStep.
  Materialize context after the execution lock inside that transaction.
- The authoritative result seam is ResultInboxService.apply. Reuse its transaction
  manager and lock order; do not call a nested standalone mutation transaction.
- Any forced failure after an earlier write must prove full rollback and clean
  retry using real PostgreSQL.

Bounds and security
===================

- Apply bounds to the complete canonical UTF-8 context envelope, not just leaf
  values. Count Unicode correctly. Reject non-JSON values, unsafe keys, excess
  depth, excess selector counts, duplicates, and oversized strings deterministically.
- Default M2C envelope ceiling: 64 KiB canonical UTF-8, 128 selected state keys,
  nesting depth no greater than the existing JSON safety boundary. If current
  executable constraints reveal a safer smaller value, document and test it;
  never silently increase it.
- Default M2D artifact ceiling: 128 projected references per attempt. Expose only
  bounded Tenvyr reference data, never bytes and never automatic full metadata.
- Artifact URI is opaque untrusted data. Never fetch, probe, normalize as a path,
  redirect, resolve DNS for, or use it as transport configuration.
- Do not log state values, artifact metadata, URIs, result output, context payloads,
  signed URLs, or secrets. Log opaque identities, versions, counts, sizes, hashes,
  and dispositions where operationally useful.

Stage stop rules
================

Stop and report a blocker instead of inventing policy if:

- satisfying a stage requires breaking Agent Protocol v1 for old readers;
- satisfying it requires Tenvyr to own, upload, download, or verify artifact bytes;
- it requires authentication, tenant isolation, retention, deletion, encryption,
  malware scanning, or signed-URL product policy not already approved;
- it requires provider-specific prompt construction or reasoning;
- it requires Planner, PlanPatch, budgets, approvals, native subagents, semantic
  search, RAG, long-term memory, or replay execution;
- the disposable PostgreSQL target cannot be proven safe.

Do not stop for ordinary uncertainty that repository evidence can resolve. Inspect
the code, choose the smallest design consistent with the specs, document the
decision, test it, and continue.

Final program gate and report
=============================

After M2F, run the complete gate ladder in
docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md.
Run the real PostgreSQL Orchestrator suite twice sequentially. Inspect the final
diff file by file. Confirm all current docs and the implementation ledger match
executable truth, but leave every program plan active for the Tech Lead.

Your final response must contain:

1. one line per stage: READY FOR INDEPENDENT TECH LEAD REVIEW or BLOCKED;
2. the exact file path of every stage receipt;
3. migrations added in registered order;
4. production and test file inventory grouped by stage;
5. exact verification commands with exit status and test counts;
6. failures encountered and repairs made;
7. remaining limitations and explicit out-of-scope boundaries;
8. final `git status --short`;
9. a direct request for the Tech Lead to independently verify before closure.

Begin now. Read the durable files first, inspect the live dirty tree, inherit the
existing M2B work, and continue through every green stage without waiting for an
extra prompt.
```
