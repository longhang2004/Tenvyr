---
title: Roadmap
status: current
audience:
  - developer
  - product
last_verified: 2026-08-17
sources:
  - docs/plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/GOAL.md
  - docs/plans/active/tenvyr-productization-roadmap/ROADMAP.md
  - docs/reference/implementation-status.md
---

# Roadmap

Roadmap documents describe intended work, not current runtime guarantees. Check the [implementation status ledger](../reference/implementation-status.md) and current architecture or operations documentation before relying on a capability.

## Status legend

- `implemented`: source and executable tests prove current behavior; details belong in architecture or the status ledger.
- `partial`: a useful subset exists, but the named capability is not complete.
- `planned`: direction is recorded without a current implementation guarantee.
- `blocked`: progress depends on an explicit owner, legal, infrastructure, or release decision.
- `historical`: retained context, not current direction or behavior.

## Current roadmap — Product Pivot 1 (coding-agent control plane wedge)

**"Run your coding agents as a team — without babysitting terminals."**
Tenvyr supervises Codex / Claude Code / OpenCode and other runtime-owned
agent harnesses: execution authority, workspace boundaries, supervision,
bounded context, approval, provenance, and evidence.

The near-term product sequence is bounded to:

```text
Product Pivot 1
→ Workspace execution / isolation        (implemented: shared + git-worktree, lease lifecycle)
→ Attention                               (implemented: exception-driven queue + /attention)
→ Handoff                                 (implemented: HandoffBundleV1 + continuation)
→ real-runtime dogfood                    (next: opt-in Codex / Claude Code / OpenCode)
```

Planned/next work after the deterministic vertical:
- [PP1 slice documents](../plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/GOAL.md)
- real-runtime manual dogfood (Codex / Claude Code / OpenCode; opt-in, no
  paid credentials in CI) — the Technical Lead selects the next feature
  only after that measured evidence.

Not scheduled: memory, RAG, provider routing, sandbox platform, generic
agent framework, task-collision guard, automatic merge/push.

## Closed / historical sequences

- [M8–M11 productization roadmap](../plans/active/tenvyr-productization-roadmap/ROADMAP.md)
  — Runtime Connections, Supervised Agent Team Execution, the Operator
  Workbench, and single-owner self-hosting are IMPLEMENTED (implementer
  status; independent verification remains the owner's decision). Its
  planning authority is superseded by the PP1 sequence above.
- [P3 runtime harness optimization / context efficiency](../archive/plans/tenvyr-productization-roadmap/P3-runtime-harness-optimization/GOAL.md)
  — implemented baseline (ContextBundle identity, projection reuse,
  efficiency evidence); plan archived.
- [Observability, provenance, and product differentiation](observability-provenance.md)
  — older thematic research. Implemented portions are superseded by M0–M7 truth;
  remaining themes are discovery inputs, not a competing execution sequence.

Plans and historical records may explain why a direction was chosen, but they do not override contracts, production code, tests, or current documentation.