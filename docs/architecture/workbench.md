---
title: "Tenvyr Operator Workbench (M10)"
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-16
sources:
  - services/orchestrator/src/services/workbench-projection.service.ts
  - services/orchestrator/src/workbench.controller.ts
  - services/gateway/src/app.controller.ts
  - services/orchestrator/src/services/runtime-connection.service.ts
---

# Operator Workbench (M10)

## Purpose

A single trusted operator's local control plane for M3–M9 authority:
connections, supervised team runs, live loop state, WAIT actions, and
inspection — without service calls or database knowledge. Loopback /
private trusted-operator only: the External Production Exposure Gate stays
OPEN, so the Workbench surface is internal and must display that
limitation.

## Authoritative projection

Workbench read models are bounded projections assembled from current
services and PostgreSQL records — cache, Socket.IO, polling, browser
storage, and telemetry never decide authority. Every response carries
stable ids, a server timestamp, per-section bounds with truncation
metadata, and NO raw secrets, credential refs, unselected context, raw
logs, chain of thought, or artifact bytes.

## Implemented (slice 1 — read projections)

- `GET /workbench/connections` — connection cards: id, name, runtime kind,
  executor, tested version, status, reason code, last test time, bounded
  declared capabilities, revoked flag. Detection ≠ authentication;
  connection ≠ provider account.
- `GET /workbench/executions?page=N` — bounded execution summaries with
  coordination phase and current iteration number, pagination bounds and
  truncation flags.
- `GET /workbench/executions/:id` — the full projection: execution summary
  with bounded goal preview (truncation metadata), coordination run
  (phase, iteration, cumulative workers, hard limits, remaining deadline,
  budget account, wait reason), iterations (planner step, worker manifest
  with required flags and statuses, verifier step, consumed decision
  action + hash, outcome), bounded attempt summaries (never raw snapshots
  or results), approval counts, bounded artifact references, and declared
  bounds.
- Gateway proxies `api/workbench/*` to the orchestrator.

## Implemented (slice 1 — read projections)

- `GET /workbench/connections` — connection cards: id, name, runtime kind,
  executor, tested version, status, reason code, last test time, bounded
  declared capabilities, revoked flag. Detection ≠ authentication;
  connection ≠ provider account.
- `GET /workbench/executions?page=N` — bounded execution summaries with
  coordination phase and current iteration number, pagination bounds and
  truncation flags.
- `GET /workbench/executions/:id` — the full projection: execution summary
  with bounded goal preview (truncation metadata), coordination run
  (phase, iteration, cumulative workers, hard limits, remaining deadline,
  budget account, wait reason), iterations (planner step, worker manifest
  with required flags and statuses, verifier step, consumed decision
  action + hash, outcome), bounded attempt summaries (never raw snapshots
  or results), approval counts, bounded artifact references, and declared
  bounds.
- Gateway proxies `api/workbench/*` to the orchestrator.

## Implemented (slice 2 — command surface)

- `WorkbenchCommandService` + `WorkbenchCommandsController`
  (`/workbench/commands`): idempotent local operator commands through
  EXISTING authority services —
  `POST start-team-run` (pipeline + execution + coordination run +
  iteration 1 from a validated team template; the recovery tick drives the
  engine), `POST waits/:runId` (approve/deny through `resolveWait`),
  `POST executions/:id/cancel` (existing whole-execution authority),
  `POST executions/:id/replay` (Capsule replay → new execution + fresh
  run), `GET audit` (bounded trail).
- Exactly-once delivery: the audit row (`operator_actions`, migration
  `1722270016000-MilestoneTenOperatorActions`, UNIQUE (action,
  idempotencyKey)) is inserted FIRST — a concurrent duplicate blocks on
  the unique index and returns the stored outcome WITHOUT re-executing
  authority. Outcome is CAS-updated in the same transaction: a crash can
  never leave an executed command without evidence.
- Every command records durable audit evidence (actor, action, key,
  target, redacted payload, outcome). The UI never dispatches a Worker,
  applies a PlanPatch, advances an iteration, or marks completion
  directly.
- M10 closure hardening: Runtime Connection operations (create / revise /
  test / revoke) run through the SAME audited command layer — the
  operator-action evidence row and the authority mutation commit in ONE
  transaction (manager-aware service variants), a retry with the same
  idempotency key returns the stored outcome (never a second revision,
  never a second revocation), and the same key with a CONFLICTING payload
  is rejected (`IDEMPOTENCY_CONFLICT`). The Workbench page and the gateway
  proxies send idempotency keys on every connection mutation; no
  un-audited lower-level mutation path is reachable from the Workbench
  surface. Test-connection evidence is a bounded secret-free receipt;
  credentials never enter audit payloads.

## Implemented (slice 3 — Workbench shell)

- `GET /workbench` on the gateway serves a self-contained accessible page
  (no framework, no build step): connection cards, the launch form
  (goal + planner/verifier/workers + VISIBLE hard limits — max
  iterations, per-iteration workers, total workers, deadline, optional
  budget account), execution list with live phase/iteration, and an
  execution detail with the supervised team loop (phase, iteration N of
  max, workers with required/optional and statuses, verifier step,
  decision), WAIT approve/deny buttons, cancel, and replay-as-new.
- Bounded polling (3s) reconstructs the same view from server state;
  duplicate clicks are idempotent via the command idempotency keys;
  terminal state never regresses in the UI.
- Accessibility gate (the smallest recorded gate): labels for every
  input, semantic tables for workers/attempts (screen-reader
  equivalents), status shown as text — never color-only, `aria-live`
  region, `aria-labelledby` sections, keyboard-operable native buttons,
  viewport/zoom-safe layout, no remote scripts, no `eval`.
- The external-production limitation is displayed in the page itself.

## Implemented (slice 4 — inspection)

- Delegation counts in the execution projection (bounded, truncation
  flag; unavailable sections are never invented).
- `GET /workbench/executions/:id/capsule` — bounded Capsule summary
  (header counts, budget/policy/approvals/delegation/artifacts,
  coordination projection, evidence-completeness warnings).
- `POST /workbench/commands/compare` — bounded structural comparison of
  two executions (idempotent, audit-recorded); live captures report
  `unavailable` for outcome drift — no invented conclusion.
- Workbench page sections: artifact references (labeled references —
  never bytes), delegation, Capsule view, compare form, operator action
  audit trail — all bounded and truncated with explicit notes.

## Implemented (slice 5 — Canonical Next.js Operator Workbench)

- Canonical Operator Workbench UI hosted via Next.js on port 4000:
  - `/dashboard`: System readiness, runtime connection summary, active/recent runs, pending approvals attention, New Team Run CTA.
  - `/runtimes`: Two tabs — **Agent Runtimes** (guided onboarding for Codex, Claude Code, OpenCode: CLI auth guidance, runtime-owned provider rows, connection testing, revision, revocation) and **Advanced Catalogs** (P2).
  - `/workspaces`: Workspace repository management, frozen snapshot views, mutable working tree contract clarity.
  - `/runs/new`: Progressive team run wizard (Goal -> Workspace -> Team selection with template defaults -> Guardrails -> Acceptance evidence -> Client-side UUID idempotency launch).
  - `/runs/[executionId]`: Supervised loop visibility (phase pipeline, iteration history, planner proposal cards, worker manifests, verifier decision outcome/reason/recommendation, WAITING_FOR_HUMAN approval/denial banner, Capsule drawer/tab, replay/cancel actions).
  - `/runs`: All executions table with filter and pagination.
  - `/approvals`: Dedicated human approval queue with one-click decision resolution.
  - `/advanced/pipelines`: Migrated legacy pipeline YAML registration, execution triggering with reliable local default payload, DAG visualizer.
  - `/advanced/audit`: Operator action audit log and execution comparison.
  - `/workbench`: Canonical route parity redirecting to `/dashboard`.
- Strongly-typed API client in `frontend/src/lib/tenvyr-api/` with typed DTOs, normalized error handling, and unit test coverage.
- Bounded planner proposal, decision reason, and recommendation projection fields in `WorkbenchExecutionProjectionV1`.
- Gateway proxying and Next.js route rewrites for seamless local and production operations.

## Implemented (P2 — runtime-owned provider connections + auth UX)

- `/runtimes` is now two tabs:
  - **Agent Runtimes** — guided runtime cards per CLI (Codex, Claude Code,
    OpenCode): Installed / Version / Authentication / Connection status /
    Default Model, with **Test Runtime**, **Models**, and **Manage** actions.
    Cards expand into runtime-owned **Provider Connections**:
    - **OpenCode** — first-class provider management: one row per provider
      (provider id, Connected / Not connected, **Models** and **Test** per
      connected provider). A not-connected provider offers **[Connect]**,
      which copies the OFFICIAL `opencode auth login --provider <id>`
      command with **Copy Command** / **Check Again** — Tenvyr never
      collects provider credentials, never executes the command itself,
      and only re-probes after the operator reports they ran it.
    - **Codex / Claude Code** — a single implied provider (OpenAI /
      Anthropic) whose auth status comes from the runtime onboarding
      probe.
  - **Advanced Catalogs** (renamed from Model Sources) — generic
    OpenAI-compatible endpoints only; an existing 9Router instance is just
    such an endpoint, not a Tenvyr product concept.
- New audited Workbench command actions — `model-source-create/update/
delete/test/refresh` — idempotent and audit-recorded exactly like the M10
  connection commands (create / revise / test / revoke): one transaction for
  the evidence row + authority mutation, same idempotency-key replay and
  `IDEMPOTENCY_CONFLICT` handling. Catalogs are bounded on-demand
  projections and are never persisted. These commands run through the
  runCommand EntityManager (M10 atomicity invariant restored), and
  `WorkbenchCommandService` received the real `ModelSourceService`
  dependency — the P2 DI crash is fixed.
- Connection-test contract: the test receipt is nested under
  `data.result.receipt`; the frontend parses it with typed guards and never
  fabricates readiness — a malformed or missing receipt renders
  `Unknown / malformed response`, never `READY`. All workbench command
  envelopes are parsed with `parseWorkbenchCommandResult`
  (executed / duplicate / rejected / malformed) — never optimistic
  defaults.
