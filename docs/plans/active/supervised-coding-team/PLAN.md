---
title: "Product Phase 1 — Real Supervised Coding Team Dogfood (plan)"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-15
sources:
  - services/orchestrator/src/domain/workspace.ts
  - services/orchestrator/src/domain/team-templates.ts
  - services/orchestrator/src/services/runtime-onboarding.service.ts
  - services/orchestrator/src/phase1-team-dogfood.integration.spec.ts
---

# Product Phase 1 — Real Supervised Coding Team Dogfood (plan)

Status: in progress (implementer). Scope: the MINIMUM coherent product slice
that lets a technical single-owner operator connect real runtimes, select a
repository, launch a supervised team, observe bounded iterations, and receive
a controlled auditable result. M0–M11 invariants are preserved; no milestone
is reopened.

## Current-state audit (repository truth, 2026-08-15)

- M8 runtime connections: REAL. Version-pinned templates (codex/claude/
  opencode) with fixed run argv + bounded probes (`cli-probe.ts`), connection
  CRUD + test + revoke + claimRevision, `generic-cli`/`http-worker`/
  `kafka-worker` kinds, executor-host binding with frozen revision identity
  (`configHash`), fail-closed on mismatch. Real-CLI execution is operator-
  configured at the local-executor-host (fixed command/argv/cwd/env per
  agent, M3 trusted-code boundary).
- M9 supervised team execution: REAL. Planner -> TaskBatchProposal ->
  authority gates (connection revocation, executor allowlist, iteration
  identity) -> workers -> fan-in -> Verifier (bounded context, never COT) ->
  ACCEPT/CONTINUE/FAIL/WAIT_FOR_HUMAN -> automatic next iteration. Proven
  end-to-end through the real HTTP transport in `m9-team-example.spec.ts`
  (CONTINUE -> ACCEPT, 2 iterations, Capsule).
- M10 workbench: REAL. Workbench projection + command service (start-team-run,
  resolve-wait, cancel, replay, compare, connection actions, audit) +
  gateway-served `workbench-page.html` operator UI (connection cards +
  raw add/revise, launch form with bounds, executions list/detail, Capsule,
  compare, audit, WAIT approvals).
- M11: closed (per the handoff).

## Real gaps between the primitives and usable team execution

1. NO Workspace concept anywhere: runs freeze a goal + config but never the
   repository (path, root, branch, HEAD SHA, dirty state). Workers receive
   only planner-authored JSON; the run cannot reconstruct what was executed
   against.
2. NO guided runtime onboarding: probe machinery exists but the operator must
   fill the raw connection form (executable, probe args, capabilities).
   No "Installed / Version / Auth / Connect / Test" flow.
3. NO team templates.
4. NO acceptance-evidence capture (test/build/lint/typecheck commands,
   required artifacts) on a run.
5. UI gaps: no workspace field, no run summary block (outcome/iterations/
   runtime team/evidence/iteration history), no iteration history view.

## Implementation (smallest coherent slice)

Backend (orchestrator):
- WorkspaceSnapshotV1 (bounded) + WorkspaceEntity + migration +
  WorkspaceService: freeze path -> git identity (root/branch/HEAD/dirty)
  via BOUNDED git probes; non-git or missing dir is a valid best-effort
  snapshot (nullable fields), never a crash.
- CoordinationRunEntity.workspace jsonb (frozen snapshot) + acceptance
  evidence jsonb (optional test/build/lint/typecheck commands + required
  artifacts, run metadata only) + migration.
- startTeamRun accepts workspace (path | workspaceId) + acceptanceEvidence.
- Worker input envelope gains the frozen workspace snapshot at batch
  admission (bounded). VerifierContextV1 gains the workspace snapshot.
- Capsule coordination section + workbench projection/detail include the
  workspace snapshot + acceptance evidence.
- `GET /workbench/onboarding/:runtimeKind` (detect executable -> version
  probe -> auth probe; never reads credentials) +
  `POST /workbench/commands/onboard-runtime` (detect -> create -> test,
  one click) + `GET /workbench/commands/team-templates`
  (software-engineering, code-review) + `POST /workbench/commands/
  create-workspace` + `GET /workbench/workspaces`.

Frontend (gateway workbench-page.html):
- Runtime onboarding cards (Codex/Claude/OpenCode) with
  Installed/Version/Auth/Connect/Test; Generic CLI stays the raw form.
- Launch form: workspace (path or existing), template prefill buttons,
  acceptance-evidence fields.
- Execution detail: run summary block (outcome, iterations, runtime team,
  evidence, iteration history), workspace snapshot, acceptance evidence.

Tests:
- workspace.service.spec (unit: git identity bounded, non-git, missing).
- runtime-onboarding.spec (unit: fake executables on a temp PATH:
  detected/version/auth/not-detected).
- team-templates.spec (unit: shapes + bounds).
- phase1-team-dogfood.integration.spec (Postgres): workspace freeze ->
  workbench start-team-run with deterministic agents -> automatic
  CONTINUE -> ACCEPT; asserts the frozen workspace in worker inputs,
  VerifierContext, Capsule, projection, and the run summary; bounds and
  connection-revoked paths still block.
- workbench projection spec additions.

Docs:
- docs/operations/supervised-coding-team.md (connecting runtimes, auth
  ownership, workspace, team runs, CONTINUE, bounds, WAIT_FOR_HUMAN,
  trusted-code limitation, Capsule) + docs/README.md index + EXECUTION_STATUS
  row + implementation-status.json entry.
- Opt-in live dogfood scenario documented; deterministic dogfood is the
  Postgres spec (no paid credentials in CI).

Non-goals preserved: no sandbox claims (trusted-code-only), no provider
credential handling, no multi-tenancy, no scheduler rewrite.
