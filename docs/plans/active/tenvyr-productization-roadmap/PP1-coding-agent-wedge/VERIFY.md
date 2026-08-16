---
title: "PP1 VERIFY: Coding-Agent Control Plane Wedge"
status: planned
audience:
  - developer
last_verified: 2026-08-17
sources:
  - docs/plans/active/tenvyr-productization-roadmap/PP1-coding-agent-wedge/SPEC.md
---

# PP1 VERIFY — verification gates

## Focused gates

1. Real-host workspace dogfood (`pivot1-workspace-dogfood`): selected
   workspace A → isolated worktree B (B ≠ A); planner/worker/verifier
   child cwds == B; worker mutation in B; source A byte-identical;
   planner-authored cwd fields cannot override; workspace-less and
   traversal invocations fail closed BEFORE spawn; lease lifecycle
   PRESERVED with uncommitted work; Capsule + Workbench preserve identity.
2. Attention: WAIT → one deterministic item; decided approval removes it;
   FAILED → failure item; LIMIT_REACHED → limit item; preserved dirty
   workspace → workspace item; healthy RUNNING creates none; polling does
   not duplicate; resolution never bypasses authority.
3. Handoff vertical: terminal run → bounded HandoffBundle (strict parse,
   no credentials/reasoning); continuation on a DIFFERENT runtime; source
   Runtime Target unchanged; continuation is a NEW execution; lineage in
   destination Capsule; exclusive worktree transfer (source TRANSFERRED,
   destination new lease); run-1 uncommitted work preserved; source repo
   untouched; non-terminal continue fails closed.
4. Host unit regressions: valid member accepted; traversal/symlink escape
   rejected; `requireExecutionWorkspace` fails closed; malformed member
   rejected; absent member falls back to static cwd.

## Full gates

```bash
pnpm test:all
pnpm build:all
pnpm --filter frontend lint
pnpm --filter frontend typecheck
pnpm --filter frontend test
pnpm --filter frontend build
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
python scripts/sync-python-worker-schemas.py check
python -m pytest sdks/python-worker/tests
pnpm self-hosted:contract-test
git diff --check
```

Schema changes (workspace_executions + handoffs) imply: real PostgreSQL
integration suite twice + `pnpm self-hosted:recovery-test`. Hosted CI
requires no paid provider credentials.