# Tenvyr

## What Tenvyr is

Tenvyr is a framework-neutral execution control plane for supervised agent
workflows. It runs Python, TypeScript, and Java-backed agents as persisted
steps, with standardized results, retries, timeouts, idempotency, callback
security, and one dashboard for inspecting what happened.

Tenvyr owns when work runs, which runtime and transport execute it, and how the
workflow records success or failure. Agent applications keep ownership of
prompts, tools, reasoning, frameworks, and model-provider calls.

Runtime Connections (M8) let an operator configure, detect, health-check,
revoke, and freeze Codex, Claude, OpenCode, Generic CLI, HTTP Worker, and
Kafka Worker connections. Every claimed attempt freezes a secret-free
connection revision and conservative capability set; provider selection and
authentication stay inside the runtime.

## Why it exists

Agent code is easy to start and hard to operate. A production workflow needs a
durable execution record, bounded retries and timeouts, authenticated callbacks,
failure classification, and a consistent contract across languages. Tenvyr
puts those controls outside the agent process so each Worker stays isolated and
replaceable.

## What it is not

Tenvyr is not a universal LLM gateway, model router, agent framework, prompt
playground, or substitute for a model's native reasoning tools. It is not a
provider registry, credential vault, or sandbox: local execution is
trusted-code-only, Runtime Connections store credential references (never
values), and the External Production Exposure Gate keeps administration
local/self-hosted.

## Native subagents vs Tenvyr

Native subagents decompose and reason about a task inside an agent environment.
Tenvyr supervises execution outside that environment: dispatch, runtime choice,
timeouts, retries, persisted state, standardized results, and auditability. A
Tenvyr Worker may call native subagents; the boundaries are complementary.

## Architecture

```text
Dashboard -> Gateway -> Orchestrator -> persisted pipeline state
                              |-> Kafka -> specialized agent -> Java Runner -> model
                              `-> HTTP  -> Python/TypeScript Worker -> model or framework
                                           `-> signed callback -> Orchestrator
```

Kafka runtime v1 supports the current specialized agents. HTTP protocol v1
dispatches asynchronously to TypeScript or Python Workers and authenticates
callbacks with HMAC signatures. Both paths produce the same versioned
`AgentResultV1` contract.

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

| Runtime connection | Pinned version | Probe (documented, non-billable)                    |
| ------------------ | -------------- | --------------------------------------------------- |
| Codex CLI          | 0.147.0        | `codex login status` (auth; version output not documented) |
| Claude Code        | 2.1.228        | `claude --version` + `claude auth status`           |
| OpenCode           | 1.18.16        | `opencode --version` (provider auth is runtime-owned) |
| Generic CLI        | operator-declared | fixed `--version`-style probe per operator profile  |

Live gates are opt-in and non-billable; deterministic fake-CLI conformance
tests always run. Detected installed versions are evidence — the pin is the
version the profile was written against.

Gemini, Azure OpenAI, Bedrock, Vertex AI, and other compatible providers can be
called from Worker application code, but they are not first-class verified
v0.1.0 integrations. See [using model providers](docs/showcase/using-model-providers.md).

## Quick start

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
