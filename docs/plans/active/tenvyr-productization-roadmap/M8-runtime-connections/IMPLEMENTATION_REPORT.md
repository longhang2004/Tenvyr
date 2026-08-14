---
title: "Tenvyr M8 Implementation Report: Runtime Connections"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/EXECUTION_STATUS.md
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/VERIFY.md
---

# M8 Runtime Connections — implementation report

Provisional implementer report. Sol audits closure; this document cannot
write `PASS`, `SAFE TO CLOSE`, or `CLOSED`.

## Implemented

- Immutable, secret-free Connection Revisions: durable
  `runtime_connections` + `connection_revisions` tables with a database
  trigger blocking UPDATE/DELETE, `UNIQUE (connectionId, revisionNumber)`,
  and canonical `configHash` coherence on read.
- Atomic lifecycle service: `createConnection` (revision 1, DRAFT),
  `reviseConnection` (pessimistic lock + append N+1), `revokeConnection`
  (terminal, denies claims and pending delivery), `claimRevision` (current
  revision as one coherent identity; retry/replay re-resolve current).
- Frozen attempt identity: `ConnectionReferenceV1` embedded in every
  attempt's `ExecutorDescriptorV1` when the agent selects a connection;
  dispatch consumes the frozen reference; `EXECUTOR_CONNECTION_REVOKED`
  denies pending delivery deterministically, no fallback.
- Conservative capability vocabulary (12 keys) with downgrade-only
  detection; missing = unsupported; capability spoofing rejected at parse.
- Bounded probes and test receipts: fixed CLI profiles (no shell, no
  pipeline commands), deadline/output caps, minimum environment, declared
  auth exit mappings (never output inference), rate limit + per-connection
  in-flight dedupe; receipts are secret-free and never mutate attempts.
- Version-pinned runtime profiles from live official docs (2026-08-12):
  Codex 0.147.0, Claude 2.1.228, OpenCode 1.18.16, plus Generic CLI.
- Local/internal product surface: `GET/POST /connections` list/status/test/
  revoke on the orchestrator + gateway proxy, behind the open External
  Production Exposure Gate.

## Product outcome and operator evidence

An operator can now create a Runtime Connection for Codex, Claude, OpenCode,
or a Generic CLI; test it (operator-initiated, rate-limited); see
AVAILABLE / AUTH_REQUIRED / UNAVAILABLE / DEGRADED status; revise to a new
immutable revision; revoke (future claims and pending delivery denied); and
bind it to agents via `AGENT_TRANSPORT_CONFIG.connectionId`. Every claimed
attempt freezes the exact revision — rotation, retry, and replay can never
reroute or resurrect historical authority. Live non-billable gates ran
against the installed CLIs on 2026-08-12 (installed Claude Code 2.1.97 vs
pin 2.1.228 — detected versions are evidence, pins are tested versions).

## Architectural decisions and deviations permitted by SPEC

- Agent → connection binding via `connectionId` on the existing
  `AGENT_TRANSPORT_CONFIG` entry (connection wraps transport config;
  SPEC-aligned, no provider routing in core).
- Probe auth mapping is operator-declared (`authExitCodes`,
  `authAnyNonZero` for documented "exit 0 when logged in" semantics);
  `expectsVersion` ensures auth output never becomes a tested version.
- `codex --version` is NOT documented → no version probe invented; Codex
  probes `codex login status`; the pin is operator-declared.
- Dispatch-time revocation check consults only the REVOKED state; health
  status is projection, never dispatch authority.
- No deviations from SPEC; no provider inference added to authority core.

## Migrations and data changes

`1722270014000-MilestoneEightConnections`: two tables + immutability
trigger + FK + indexes; `down()` drops trigger, function, tables. Restart/
upgrade/rollback repeat-safety proven in migration spec and by re-running
the suite twice against a re-created schema.

## External research and pinned versions

Official pages re-fetched 2026-08-12 (recorded in RESEARCH_REGISTER.md and
`runtime-profiles.ts`): Codex CLI `rust-v0.147.0` (developer-commands,
non-interactive-mode, setup, auth); Claude Code 2.1.228 (cli-reference,
npm latest); OpenCode 1.18.16 (cli docs, GitHub release). Allowed and
explicit unsupported surfaces per runtime recorded in the templates.

## Tests and verification evidence

Commands (all run 2026-08-12):

- `npm test -- --runInBand` (orchestrator): 620 passed, 2 Postgres suites
  skipped without `TEST_DATABASE_URL`; gateway 2/2; local-executor-host
  33/33; worker 199/199 (one load flake on first parallel run, green on
  three subsequent runs); `python -m pytest` (venv) 261/261.
- `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test npm test -- --runInBand`
  run TWICE at slice ends and twice at milestone end: 882 passed each final
  run (45 suites + 1 opt-in skip: local-executor-host loopback without
  `EXECUTOR_HOST_MAIN`). Coverage: immutable-revision trigger; concurrent
  revise/revoke/claim coherence; rotation no-reroute; revocation denies
  claims + pending delivery; retry/replay current-revision; migration
  restart-safety; Capsule provenance with exact revision and no secrets;
  fake-CLI probes per runtime (AVAILABLE/DEGRADED/AUTH_REQUIRED/
  UNAVAILABLE); minimum-env secret isolation; failed tests never mutate
  attempts.
- `pnpm test:all`: all 14 package test runs Done.
- `pnpm build:all`: 15 packages built, no errors.
- `pnpm test:docs` 20/20; `pnpm verify:docs` (115 files, 222 links);
  `pnpm test:identity` 25/25; `pnpm verify:identity` 0 violations;
  `pnpm verify:package-packs` passed; `git diff --check` clean.
- Live gates (opt-in, non-billable): installed codex/claude/opencode
  version + auth-status probes with bounded secret-free outcomes.

## Security review and trust boundaries

- Secrets: credentials are env references only; values never enter
  profiles, revisions, descriptors, events, Capsules, receipts, or status;
  probes run with a minimum environment; auth output is never parsed;
  structural rejection of non-reference credential shapes.
- Immutability enforced in code (deep freeze) and durably (trigger).
- No shell, no pipeline-supplied commands, no fallback routing, no provider
  inference, no auth-file inspection, no consumer-session brokerage.
- Local executor host remains trusted-code-only — no sandbox claim.
- Administration is local/internal; the External Production Exposure Gate
  stays OPEN (no public admin claim).

## Documentation and implementation-ledger updates

- `docs/architecture/executors/runtime-connections.md` (slices 1–5);
  `docs/operations/configuration.md` (`connectionId`);
  `RESEARCH_REGISTER.md` (2026-08-12 recheck);
  README (architecture, runtime matrix, non-goals, limitations);
  `docs/reference/implementation-status.md` + `.json`
  (`runtime-connection-domain`: implemented, Sol-gated).

## Remaining limitations

- Closure is Sol's decision.
- Local/internal administration only until the exposure gate is separately
  approved.
- Probe concurrency is per-connection; a global semaphore matters for
  multi-replica deployments.
- Installed CLI versions may differ from pins; live gates are opt-in.
- No workbench UI yet (M10); no A2A/MCP adapters; publication still blocked.

## Claimed closure status

`READY FOR INDEPENDENT SOL VERIFICATION` — implementer verification
complete; Sol audit requested. DeepSeek does not approve M8.

# Milestone handoff

## What was delivered

Durable, immutable, secret-free Runtime Connections with atomic
create/revise/revoke/claim, frozen attempt identity, bounded probes and
test receipts, version-pinned Codex/Claude/OpenCode/Generic CLI profiles
from live official docs, and a local list/status/test/revoke API surface.

## User/operator value

Real agent runtimes become selectable and health-checkable without turning
Tenvyr into a model router or credential proxy. Operators see truthful
connection status, test before use, freeze exact revisions into attempts,
and revoke with deterministic effect.

## How it works

Operators configure a connection (fixed CLI profile + credential
references + declared capabilities), bind it to an agent via
`connectionId`, and use the connection API to test/revoke. Attempt claims
freeze the current revision into the executor snapshot; dispatch consumes
the frozen reference; revocation denies future claims and pending delivery.

## Guarantees

Revisions immutable and secret-free (code + trigger); detection never
widens authority; only REVOKED blocks dispatch; rotation/retry/replay never
reroute or resurrect historical authority; receipts never leak secrets or
command output; failed tests never mutate attempts.

## Known limitations

Local-only administration; per-connection probe concurrency; opt-in live
gates; installed versions may differ from pins; no UI yet.

## What this unlocks

M9 (Supervised Agent Team Execution) can select real runtimes through
truthful frozen connection identity while remaining verifiable with
deterministic Workers.

## Recommended next milestone

M9 Supervised Agent Team Execution, after Sol closes M8.

## Closure hardening (2026-08-14, implementer)

- `claimRevision` is now LINEARIZABLE: the claim transaction locks the
  RuntimeConnection authority row (pessimistic write) and re-verifies
  existence, non-revocation, and the current revision number under that
  lock. A revoke committed before the claim lock denies the claim
  (CONNECTION_REVOKED); a claim that locks first returns its immutable
  frozen revision and the later revoke applies at dispatch. The
  manager-aware `claimRevisionWithManager` enforces the identical rules
  inside caller-owned transactions (attempt claim/scheduling, batch
  admission, run creation) — no unlocked reads remain on the claim path.
- Python Worker schema parity restored through the canonical sync process
  (`scripts/sync-python-worker-schemas.py`): the packaged
  `agent-invocation.v1.schema.json` now carries the optional `connection`
  identity; both acceptance paths proven (canonical invocation with
  connection identity parses; invocation without connection remains
  compatible).
- Real-PostgreSQL regression tests: revoke-wins, claim-wins (lock
  serialization), revise-vs-claim consistency (never N+1 identity with N
  config), and mixed claim/revise/revoke contention with per-result
  frozen-row consistency assertions.
