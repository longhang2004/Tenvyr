---
title: "PP1 Goal: Coding-Agent Control Plane Wedge — workspace execution, attention, handoff"
status: planned
audience:
  - developer
  - operator
  - product
last_verified: 2026-08-17
sources:
  - docs/plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/SPEC.md
---

# PP1 Goal: Coding-Agent Control Plane Wedge

Slice documents: [PLAN](PLAN.md) · [SPEC](SPEC.md) · [VERIFY](VERIFY.md)

Product wedge: **"Run your coding agents as a team — without babysitting
terminals."**

Technical category remains **Agent Execution Control Plane**. Tenvyr
supervises Codex / Claude Code / OpenCode / other runtime-owned agent
harnesses: it controls execution authority, lifecycle, workspace boundaries,
supervision, bounded context, approval, provenance, and evidence — never the
intelligence.

## Slices

1. **Workspace execution binding + Isolation V1** (Pivot Invariant 1):
   workspace selection must control the REAL execution location of every
   local coding-runtime child; shared + git-worktree modes; durable
   recoverable lease lifecycle; preservation-first cleanup.
2. **Attention Queue V1**: exception-driven read projection
   (HUMAN_APPROVAL_REQUIRED / RUN_FAILED / LIMIT_REACHED /
   WORKSPACE_REQUIRES_ATTENTION) + `/attention` UX.
3. **Portable Handoff V1**: bounded HandoffBundleV1 + audited continuation
   command + truthful lineage (source runtime target never rewritten).
4. README/docs truth cleanup + roadmap reset + Workbench IA.

## Non-goals (unchanged)

No new agent runtime, no LLM gateway, no provider router, no memory/RAG/
vector platform, no sandbox (trusted-code-only), no new workflow language,
no agent-result cache, no chain-of-thought collection, no task-collision
guard, no automatic merge/push/branch deletion, no durable ContextBundle
cache, no session reuse. M0–M11 / P1 / P2 / P3 remain CLOSED/ACCEPTED.