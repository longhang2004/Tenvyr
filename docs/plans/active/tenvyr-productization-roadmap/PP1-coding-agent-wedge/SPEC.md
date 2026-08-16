---
title: "PP1 SPEC: Coding-Agent Control Plane Wedge"
status: planned
audience:
  - developer
last_verified: 2026-08-17
sources:
  - docs/plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/PLAN.md
---

# PP1 SPEC — behavioral contract

## §0 Acceptance

1. Pivot Invariant 1 holds: a Team Run selecting Workspace W executes every
   local coding-runtime child against Tenvyr's authoritative execution path
   for W. Planner/worker-authored JSON can never choose or override cwd.
2. Isolation V1: shared + git-worktree modes; git-worktree creates one
   Tenvyr-owned isolated worktree; failed allocation is never READY and
   never silently falls back to shared; non-git directories reject
   git-worktree with a precise reason.
3. Durable recoverable lease lifecycle (ALLOCATING → READY → IN_USE →
   PRESERVED → REMOVED/TRANSFERRED, + FAILED); crash recovery never marks
   a missing worktree READY; creation is retry-idempotent.
4. Preservation over destruction: cleanup uses `git worktree remove`
   WITHOUT --force (dirty work preserved), is idempotent, handles
   already-removed worktrees; no automatic merge/push/branch deletion.
5. Attention is a READ projection with deterministic ids; items exist
   exactly while their durable source condition exists; resolution only
   via existing authority commands; polling never duplicates.
6. Handoff: bounded strictly-parsed HandoffBundleV1; terminal-source
   requirement; destination Runtime Target frozen via existing P2
   authority; NEW execution/run; truthful lineage (source history never
   rewritten); exclusive preserved-worktree transfer (no two runs share an
   IN_USE lease); failed transfer leaves no false READY.
7. No provider credentials in normal CI; no sandbox claims; the
   P3 ContextBundle/efficiency baseline is preserved and reused for
   metrics.