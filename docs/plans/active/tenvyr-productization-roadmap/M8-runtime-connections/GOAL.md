---
title: "M8 DeepSeek Goal: Runtime Connections"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/VERIFY.md
---

# M8 Goal Mode

## Objective

Deliver truthful, frozen Runtime Connections over existing executors without
becoming a provider or credential proxy.

## Slice order

1. Re-read current executor/config/attempt/migration code and official sources.
   Implement only immutable connection/revision/capability/status domain plus pure
   validation and focused tests.
2. Add PostgreSQL persistence and atomic claim resolution. Prove revise/revoke/claim
   races, migrations, restart, retry, replay, and secret-free Capsule identity.
3. Compose Generic CLI with the current Local Executor Host; add bounded discovery
   and test receipts. Preserve fixed commands, no shell, trusted-code-only claim.
4. Add version-pinned Codex, Claude, and OpenCode profiles one at a time from current
   official docs. Deterministic fake CLI tests are mandatory; live gates are opt-in.
5. Add only the local/internal connection product surface M10 needs; refresh public
   truth/docs/ledger, run VERIFY, write report, request Sol audit.

## Rules and stops

After each slice test and record evidence before continuing. Stop for unsupported
auth/legal terms, a protocol break, public ownership semantics, or secret-storage
expansion. Do not inspect auth files, accept pipeline commands, add provider routing,
fallback between connections, claim health from unverified detection, or start M9
before Sol closes M8.
