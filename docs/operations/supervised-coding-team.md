---
title: "Supervised coding team runs"
status: current
audience:
  - operator
last_verified: 2026-08-15
sources:
  - services/orchestrator/src/domain/workspace.ts
  - services/orchestrator/src/domain/team-templates.ts
  - services/orchestrator/src/services/runtime-onboarding.service.ts
  - services/gateway/src/workbench-page.html
---

# Supervised coding team runs (Product Phase 1)

This page is the first-run path for the supervised coding team wedge:

```text
Connect real runtimes
  → select a repository (workspace)
  → enter a goal
  → choose Planner / Workers / Verifier
  → launch
  → observe bounded iterations
  → approve if necessary
  → receive an accepted/failed bounded result
  → inspect the execution evidence / Capsule
```

You do NOT need to understand Tenvyr's database schemas or construct
coordination records by hand. The Operator Workbench (hosted on port 4000 at
`http://localhost:4000/dashboard` or `http://localhost:4000/workbench`) is the
canonical operator surface.

## Authentication ownership (read first)

Runtime/provider authentication is OWNED BY THE RUNTIME:

- Codex authentication → Codex owns it.
- Claude authentication → Claude Code owns it.
- OpenCode provider authentication → OpenCode owns it.

Tenvyr may detect auth readiness, display it, and reference
operator-approved environment credential names — it NEVER collects
provider passwords, never copies runtime-owned session files, and never
reads arbitrary credential files. Log in with the official CLI:

```bash
codex login          # Codex (official login command)
claude auth login    # Claude Code
opencode auth login  # OpenCode (provider auth is runtime-owned)
```

Multiple runtime connections are fine (`codex-personal`, `codex-work`,
`claude-main`, `opencode-deepseek`) — they are operator-configured
runtime identities.

## Connecting Codex / Claude Code / OpenCode

1. Open the Operator Workbench (`http://localhost:4000/runtimes`).
2. The **Runtime onboarding** section probes each supported CLI on PATH:

   ```text
   Codex CLI
   Installed: /usr/local/bin/codex   Version: 0.147.0 (operator-declared)
   Auth: ready
   [Connect] [Test]
   ```

   - `Not detected` → install the official CLI first (Tenvyr never
     downloads runtimes).
   - `Auth: required` → run the official login command shown in the
     guidance.

3. **[Connect]** creates the connection from the documented template
   (fixed run argv + bounded probes) and tests it. **[Test]** re-runs the
   connection test.

Generic CLI runtimes (or custom executable paths) use the raw
**Runtime connections** form below the onboarding cards.

## Creating a team run

In the **Launch a supervised team run** form:

1. **Run name / Goal** — the goal is the operator instruction the Planner
   decomposes (e.g. "Inspect this repository, fix the selected issue, run
   verification, and do not finish until the verifier accepts or limits
   are exhausted").
2. **Workspace** — select an existing workspace or type a repository
   path. At launch Tenvyr freezes a bounded snapshot:
   `workspace path, git root, branch, HEAD SHA, dirty state` (when
   detectable). The snapshot is injected into every worker input and the
   verifier context, and is stored on the run, the Capsule, and the
   Workbench projection. Execution runs against the mutable local working
   tree — NO snapshot isolation is claimed. Non-git directories are valid
   workspaces with nullable repository identity.
3. **Planner / Verifier / Workers** — choose agent roles or M8 runtime
   connections (connection-kind selections route through the executor
   host's frozen runtime binding). You may also pick a model per role —
   see Runtime Targets and model selection below.
4. **Bounds** — maxIterations, maxWorkersPerIteration, maxTotalWorkers,
   loop deadline, optional budget account. Bounds are frozen at launch
   and can never be raised by a Verifier decision or an ordinary
   approval.
5. **Acceptance evidence** (optional) — declared test/build/lint/
   typecheck commands and required artifact names. This is run METADATA
   only: Tenvyr never executes these commands; workers and the verifier
   reference evidence through the existing bounded evidence model.

**Templates** (Software Engineering, Code Review) prefill useful bounds
and goal framing. The Planner still proposes the actual task batch and
Tenvyr still authorizes it — templates never hardcode worker
intelligence.

## Planner / Worker / Verifier semantics

- **Planner** receives the goal + frozen plan revision and proposes a
  bounded TaskBatch (tasks with agent/connection selection, dependencies,
  required flags, timeouts). The proposal is AUTHORIZED by Tenvyr
  (iteration identity, connection revocation, executor allowlist, plan
  revision base) — never executed blindly.
- **Workers** execute the admitted tasks (each receives its bounded
  input INCLUDING the frozen workspace snapshot) and return bounded
  outputs + artifact references.
- **Verifier** receives a BOUNDED aggregation (worker outcomes, selected
  state keys, limits, prior decision, workspace snapshot — never raw
  logs or chain of thought) and returns one of:
  - `ACCEPT` — the loop terminates accepted.
  - `CONTINUE` — a new bounded iteration starts automatically (bounds
    re-checked; the Planner is invoked again for the next iteration).
  - `FAIL` — the run fails with bounded evidence.
  - `WAIT_FOR_HUMAN` — the operator approves/denies in the Workbench;
    approval resumes the loop, denial fails it.

## Runtime Targets and model selection (P2)

Team runs freeze **Runtime Targets** per role at launch:

- **Planner target** / **Verifier target** — one `{ connectionId, modelId? }`
  each; an absent `modelId` means **Runtime default** (no model argument is
  composed).
- **Worker Targets** — an `allowedTargets` allowlist of `{ connectionId,
modelId? }` entries; every entry's connectionId must already be an allowed
  connection worker.

Model selection authority stays with Tenvyr:

- The Planner may only pick from the frozen `allowedTargets`: a task whose
  `connectionId` + `modelId` do not EXACTLY match an entry is DENIED with
  `MODEL_NOT_ALLOWED`.
- Connection-only worker emission is allowed only when that connection has 0
  allowed targets (legacy) or exactly 1 (deterministic single-model
  resolution at plan compile). Two or more allowed models REQUIRE the
  Planner to specify one — Tenvyr never chooses arbitrarily.
- Revoked connections still DENY the next batch/iteration — target
  validation never bypasses revocation.

Model selection is execution provenance:

- Every attempt freezes `requestedModelId` (the identifier exactly as
  selected) into its executor descriptor; retries reuse the frozen
  descriptor and never silently switch models.
- A later catalog refresh or source deletion never rewrites historical
  attempts.
- `observedModelId` is recorded ONLY when the runtime/worker itself reports
  it in the bounded structured result — never fabricated.

## Bounds and autonomy

`maxIterations`, `maxTotalWorkers`, the loop deadline, and (when
configured) the budget account are enforced at every autonomous step: an
exhausted bound prevents further progress deterministically. A revoked
connection denies the next batch/iteration. Tenvyr never silently raises
bounds.

## Local trusted-code limitation

Local coding runtimes are TRUSTED-CODE-ONLY. Tenvyr controls execution
authority, supervision, and evidence — it does NOT provide a security
sandbox merely because it drives a runtime. Do not point this at
repositories or runtimes you do not trust. External Production Exposure
remains a separate gate; this surface is a single-owner local operator
tool.

## Execution Capsule result

Every execution produces a reconstructable Execution Capsule (evidence,
not a duplicate execution database): frozen goal + workspace identity,
plan revisions, attempts, artifacts, approvals, and the coordination
record (phase, iterations, verifier decisions). The Workbench shows the
run summary (outcome, iterations, runtime team, evidence, iteration
history) and a Capsule link. Deterministic replay is NOT claimed.

## Live dogfood scenario (opt-in, real runtimes)

With real connected runtimes:

```text
Workspace:   a small disposable git repository
Goal:        "Add a small feature, update tests, and verify the result."
Planner:     a real connected runtime
Workers:     2+ real connected runtimes
Verifier:    a real connected runtime
maxIterations: 3
```

Expected observable behavior: Planner proposes a batch → workers execute
→ fan-in → Verifier returns a decision → if CONTINUE, iteration 2
launches automatically → terminal decision (ACCEPT is valid in
iteration 1 — Tenvyr never fabricates CONTINUE).

The deterministic CI fixture (phase1-team-dogfood Postgres spec) drives
the identical loop with in-process deterministic agents and an explicit
CONTINUE → ACCEPT sequence — no paid credentials required in normal CI.
