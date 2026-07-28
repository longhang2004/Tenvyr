---
title: Documentation Plan Lifecycle
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - AGENTS.md
  - .gitignore
---

# Documentation Plan Lifecycle

Plans may use `proposed`, `accepted`, `in-progress`, `completed`, `superseded`,
`abandoned`, or `historical` as their plan lifecycle state. The document's
frontmatter `status` remains one of `current`, `planned`, or `historical`.

- Accepted and in-progress plans are tracked under `docs/plans/active/`.
- Completed plans with lasting context move to `docs/archive/plans/`.
- A superseded plan identifies its replacement with `superseded_by`.
- Plans are implementation records, not the current architecture source of truth.
- Implemented behavior belongs in `docs/architecture/`, `docs/operations/`, or a
  package README.
- Local notes, prompt drafts, and transient research belong in ignored
  `docs/_scratch/`.
