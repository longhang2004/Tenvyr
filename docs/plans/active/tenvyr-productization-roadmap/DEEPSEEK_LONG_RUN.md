---
title: "DeepSeek Long Run: Tenvyr Productization Roadmap"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/ROADMAP.md
  - docs/plans/active/tenvyr-productization-roadmap/EXECUTION_STATUS.md
  - docs/development/agent-rules.md
---

# DeepSeek long-running Goal Mode

## Objective

Execute M8–M11 sequentially, one bounded slice at a time, while preserving
Tenvyr's authority model and leaving closure to independent Sol review.

## Loop

1. Read `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/README.md`, current
   contracts/code/tests, the implementation ledger, this roadmap, and status.
2. Select only the next `READY` milestone and one slice from its `GOAL.md`.
3. Read that milestone's `PLAN.md`, `SPEC.md`, `VERIFY.md`, and current external
   official sources listed in `RESEARCH_REGISTER.md`; never rely on archived API
   assumptions when a live dependency may have changed.
4. Inspect current repository fit, record any permitted implementation decision,
   implement the smallest complete slice, and add its focused check.
5. Run focused validation, then update current architecture/operations/product
   docs and `docs/reference/implementation-status.json` for implementation truth.
6. Record exact pass/fail/skip evidence in `EXECUTION_STATUS.md`. Continue only
   when the slice has no blocker and the next work remains inside the SPEC.
7. At milestone end run every applicable `VERIFY.md` gate, including real
   PostgreSQL and integration checks, twice where required. Create
   `IMPLEMENTATION_REPORT.md` from the root template.
8. Mark only `READY FOR INDEPENDENT SOL VERIFICATION`; request Sol audit. Do not
   begin a dependent milestone until Sol records PASS/CLOSED.

## Mandatory stops

Stop and record a blocker when official runtime authentication or APIs do not
support the planned contract; a migration cannot preserve authority; a product
choice changes public behavior; a dependency is not independently closed; or a
security boundary would need broader deployment authority.

Do not weaken tests, delete failures, convert failures to skips, silently redesign
semantics, add provider inference behavior to authority core, remove Planner or
Coordinator bounds, create recursive Planner authority, harvest consumer-session
credentials, claim local execution is sandboxed, or claim closure for Sol.

## Milestone order

```text
M8 Runtime Connections
-> Sol closure
-> M9 Supervised Agent Team Execution
-> Sol closure
-> M10 Operator Workbench
-> Sol closure
-> M11 Single-owner self-hosted productization
-> Sol closure
```

Discovery-gated programs are not part of this implementation loop until the PO/BA
records the specified evidence and Sol updates the roadmap/status deliberately.
