# Tenvyr

## Run your coding agents as a team — without babysitting terminals.

Connect **Codex, Claude Code, OpenCode**, and other runtime-owned agent
harnesses. Tenvyr supervises execution, isolates workspace work, routes
exceptional decisions to you, and preserves one durable evidence trail.

> **Bring your agents. Tenvyr controls the work.**

Agent runtimes own intelligence — prompts, tools, reasoning, sessions,
models, and provider calls stay inside the runtime. Tenvyr owns execution
authority, lifecycle, workspace boundaries, supervision, bounded context,
approval, provenance, and evidence.

### How it works

```text
Connect Runtime
→ Select Repository (Workspace)
→ Goal
→ Planner
→ Workers
→ Verifier
→ Attention only when needed
→ Result / Handoff / Evidence
```

1. **Connect Runtime** — onboard Codex / Claude Code / OpenCode (or a generic
   CLI / HTTP Worker / Kafka Worker). Tenvyr detects, version-probes, and
   freezes a secret-free connection revision per attempt.
2. **Select Workspace** — choose the repository. Every Team Run picks its
   execution isolation: a **Git worktree** (Tenvyr-owned isolated execution
   workspace — the source tree stays untouched) or the **shared working
   tree**. Every runtime child of the run executes against Tenvyr's
   authoritative execution path — planner-authored JSON can never choose or
   override `cwd`.
3. **Goal → Planner → Workers → Verifier** — the deterministic Coordinator
   runs bounded iterations under policy, budgets, deadlines, and approvals.
4. **Attention only when needed** — an exception-driven queue
   (human approval required, run failed, limits reached, preserved
   workspace with uncommitted work) is the default supervision experience;
   resolution always goes through the existing authority commands.
5. **Result / Handoff / Evidence** — a terminal run can be **continued with
   another runtime** through a bounded HandoffBundle (references, never raw
   logs/credentials); every attempt freezes context bundles, efficiency
   evidence, and a reconstructable Capsule.

### What it is not

Tenvyr is not a Codex / Claude Code / OpenCode replacement, an LLM gateway,
a provider router, a memory/RAG/vector platform, a sandbox, a new workflow
language, or an agent-result cache. Local execution is trusted-code-only;
credentials are runtime-owned or reference-only. Tenvyr does not claim
secure sandboxing, deterministic LLM output, universal runtime support,
conflict-free merging, or guaranteed prompt caching.

## Technical architecture

Tenvyr is an **Agent Execution Control Plane**:

- **Control plane** (`services/orchestrator`): PostgreSQL-authoritative
  executions, immutable plan revisions, logical steps and attempts,
  policy/budget/approvals, runtime connections with frozen revisions,
  workspace execution leases (shared | git-worktree), the supervised
  Planner/Worker/Verifier loop, Capsules, attention, and handoffs.
- **Runtime boundary** (`services/local-executor-host`): trusted-code-only
  process execution of fixed operator-configured commands; every child
  spawns at the invocation's Tenvyr-validated execution workspace path
  (containment-checked inside `EXECUTOR_HOST_ALLOWED_ROOT`); structured
  results, signed callbacks, deadline/cancel supervision.
- **Operator Workbench** (`services/gateway` + `frontend`): Work / Setup /
  Advanced IA — New Run, Runs, Attention, Runtimes, Workspaces, Pipelines,
  Audit.
- **Framework-neutral SDKs**: `@tenvyr/worker` (TypeScript),
  `tenvyr-worker` (Python), and the Java Agent Runner remain supported
  execution surfaces (their showcase is documented below).

### Legacy showcase (Python / TypeScript / Kafka / Java)

Tenvyr's original showcase — Python `echo-analyzer` + TypeScript Workers +
Kafka-runtime Java `quality-gate` — remains a supported, verified surface:
Kafka runtime v1 (the legacy compatibility topics) routes to the specialized
agents, HTTP adapter v1 routes to Python/TypeScript Workers, and both
produce the same versioned `AgentResultV1` contract. See
[the showcase guide](docs/showcase/demo-guide.md) for the offline demo.

## Why it exists

Agent code is easy to start and hard to operate. A production workflow needs a
durable execution record, bounded retries and timeouts, authenticated callbacks,
failure classification, and a consistent contract across languages. Tenvyr
puts those controls outside the agent process so each Worker stays isolated and
replaceable.

## Native subagents vs Tenvyr

Native subagents decompose and reason about a task inside an agent environment.
Tenvyr supervises execution outside that environment: dispatch, runtime choice,
timeouts, retries, persisted state, standardized results, and auditability. A
Tenvyr Worker may call native subagents; the boundaries are complementary.

## Architecture

```text
Workbench (UI) -> Gateway -> Orchestrator (PostgreSQL authority)
                                  |-> local executor host -> Codex / Claude Code / OpenCode / CLI
                                  |      `-> child cwd = Tenvyr execution workspace (worktree/shared)
                                  |-> HTTP adapter v1 -> Python/TypeScript Worker -> model or framework
                                  `-> Kafka runtime v1 -> specialized agent -> Java Runner -> model
                                  `-> signed callbacks -> Orchestrator
```

The local executor host is the primary coding-runtime boundary (fixed
operator commands, trusted-code-only, workspace-validated cwd). HTTP
protocol v1 dispatches asynchronously to TypeScript or Python Workers and
authenticates callbacks with HMAC signatures. Kafka runtime v1 supports the
specialized agents. All paths produce the same versioned `AgentResultV1`
contract.

## Supported runtimes and model providers

| Path                               | Current verification                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| Python Worker                      | SDK, conformance, HTTP lifecycle, and showcase path         |
| TypeScript Worker                  | SDK, conformance, HTTP lifecycle, and package-consumer path |
| Java-backed agent                  | Kafka agent plus Java Runner unit/integration path          |
| OpenAI                             | Configured Java Runner path; no live API call in CI         |
| Anthropic                          | Configured Java Runner path; no live API call in CI         |
| Ollama                             | Configured Java Runner path; no live model call in CI       |
| Arbitrary provider inside a Worker | Provider-neutral application pattern                        |

Local runtime connection profiles (M8, official docs accessed 2026-08-12):

| Runtime connection | Pinned version    | Probe (documented, non-billable)                           |
| ------------------ | ----------------- | ---------------------------------------------------------- |
| Codex CLI          | 0.147.0           | `codex login status` (auth; version output not documented) |
| Claude Code        | 2.1.228           | `claude --version` + `claude auth status`                  |
| OpenCode           | 1.18.16           | `opencode --version` (provider auth is runtime-owned)      |
| Generic CLI        | operator-declared | fixed `--version`-style probe per operator profile         |

Live gates are opt-in and non-billable; deterministic fake-CLI conformance
tests always run. Detected installed versions are evidence — the pin is the
version the profile was written against.

Gemini, Azure OpenAI, Bedrock, Vertex AI, and other compatible providers can be
called from Worker application code, but they are not first-class verified
v0.1.0 integrations. See [using model providers](docs/showcase/using-model-providers.md).

## Quick start (coding-agent team)

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev          # concise local dev launcher (orchestrator + gateway + host + UI)
```

Then in the Workbench: **Runtimes** → onboard a runtime (Codex / Claude Code
/ OpenCode) → **Workspaces** → add your repository → **New Run** → pick the
workspace + execution isolation (Git worktree / Shared) + the team + the
goal → launch. Supervise from **Attention**; continue terminal runs with
another runtime from the run page.

See [the supervised coding team guide](docs/operations/supervised-coding-team.md)
and [local development](docs/operations/local-development.md).

### Offline showcase (original)

Requirements: Node.js 22+, pnpm 9.0.0, Python 3.11+, JDK 17, Docker, and Docker
Compose v2.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm setup:check
pnpm showcase:up
pnpm showcase:smoke
```

Open [http://localhost:4000/dashboard](http://localhost:4000/dashboard). Stop
only the showcase resources with:

```bash
pnpm showcase:down
```

## Dashboard showcase

The offline showcase records each step's runtime, transport, attempt count,
duration, safe previews, and provider metadata in the dashboard.

![Tenvyr dashboard showing a completed retry-once execution](docs/showcase/images/tenvyr-dashboard-showcase.png)

The default showcase is offline and deterministic. Unless `LLM_PROVIDER` is
explicitly exported in the invoking shell, `showcase:up` selects mock even when
Compose auto-loads a provider value from `.env`; no provider key is required.
For an exported real provider, leaving `LLM_FAILURE_MODE` unset derives `fail`.

## Showcase walkthrough

`pnpm showcase:smoke` seeds **Tenvyr Supervised Pipeline**, runs a successful
Python-to-Java-backed flow, then runs `retry-once` and verifies the Python step
completed on its second attempt. The dashboard exposes step status, runtime,
transport, attempts, duration, safe input/output previews, and provider metadata
when present. Use the [5–10 minute demo guide](docs/showcase/demo-guide.md) for an
interview flow.

## Key technical decisions

- Provider SDKs stay in agent applications; neither Worker core package depends
  on OpenAI or Anthropic libraries.
- Versioned contracts keep Kafka and HTTP execution paths interoperable.
- HTTP callbacks are signed, replay-checked, and correlated to persisted steps.
- Offline mock behavior is deterministic and labeled; real-provider failures
  derive `fail` unless `LLM_FAILURE_MODE=mock` is explicitly exported.
- Compatibility identifiers remain unchanged to avoid a protocol or data
  migration disguised as a branding change.

## Current limitations

- Worker idempotency, queues, callback delivery state, and replay tracking are
  process-local; there is no crash-durable outbox or multi-process coordination.
- Cancellation is cooperative, and remote cancellation is not implemented.
- Provider calls are application/runtime responsibilities. Java Runner token
  usage is currently estimated and labeled `usageSource=estimated`.
- Runtime Connections: connection administration is local/internal behind the
  open External Production Exposure Gate; probes are operator-initiated,
  rate-limited, and bounded; probe concurrency is limited per connection;
  health status is projection, never dispatch authority (only REVOKED denies).
- Local execution is trusted-code-only, not a sandbox.
- Protocol v1 retains compatibility identifiers documented in the
  [identity record](docs/product/identity.md).
- Packages are MIT-licensed but remain private and unpublished.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture/overview.md)
- [Local development](docs/operations/local-development.md)
- [Using model providers](docs/showcase/using-model-providers.md)
- [Portfolio case study](docs/showcase/case-study.md)
- [Implementation status](docs/reference/implementation-status.md)

## Release status

**Tenvyr v0.1.0 source release.** The owner selected the
[MIT License](LICENSE), and the exact merged `main` commit passed the complete
release workflow, including the Docker showcase. npm and PyPI packages remain
private and unpublished.
