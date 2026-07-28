# Tenvyr — Project Reference (CLAUDE.md)

Welcome to **Tenvyr**, a framework-neutral execution control plane for
supervising agent work across HTTP and Kafka transports.

---

## 📖 Project Overview

### What Tenvyr IS:

- An execution control plane outside agent processes that owns contracts,
  dispatch, supervision, security and policy boundaries, and orchestration
  state.
- Built with Node.js/TypeScript (NestJS, Next.js 15) and Java (Spring Boot) for enterprise-scale reliability.
- Designed around event-driven, Kafka-native patterns where agents act as decoupled microservices.

### What Tenvyr IS NOT:

- NOT a replacement for LangChain, CrewAI, provider SDKs, or other agent
  frameworks.
- NOT an agent prompt or framework layer; supported frameworks remain behind
  Worker and adapter boundaries.
- NOT an observability-only product; telemetry is a projection of authoritative
  execution state.
- NOT a Python-centric framework.
- NOT designed for single-process synchronous scripts.

---

## 🏛️ System Architecture & Ports

- **Gateway Service:** `http://localhost:3000` (NestJS) — Entrypoint for HTTP/WebSockets.
- **Orchestrator Service:** `http://localhost:3001` (NestJS) — Pipeline graph execution & Kafka coordinator.
- **Agent Runner Service:** `http://localhost:8085` (Java Spring Boot) — LLM execution & core processing.
- **Code Reviewer Agent:** `http://localhost:3002` (NestJS) — Static analysis + LLM reviewer.
- **Observability Agent:** `http://localhost:3003` (NestJS) — Log analysis + anomaly detector.
- **Frontend Dashboard:** `http://localhost:4000` (Next.js 15) — Visual graph builder and monitor.

Docker network: use the preserved network declared in `docker-compose.yml`.

---

## 📝 Core Glossary

- **Agent:** A standalone service that consumes tasks from an input Kafka topic, executes logic, and publishes a result event to an output topic.
- **HTTP Agent:** An operator-configured remote agent that accepts `AgentInvocationV1` asynchronously and returns `AgentResultV1` through an HMAC-signed Orchestrator callback.
- **TypeScript Worker SDK:** `@tenvyr/worker`, the Node.js reference host for the HTTP Agent protocol, with typed parsers, bounded scheduling, in-memory idempotency, cooperative cancellation, and signed callback retry.
- **Pipeline:** A declarative workflow definition (YAML/JSON) detailing steps, agent associations, dependencies, timeouts, and fallback policies.
- **Step:** An execution node within a pipeline corresponding to a specific agent invocation.
- **Execution:** A single run of a pipeline with a specific input object.
- **Task:** The concrete Kafka payload sent to an agent instructing it to perform a step's work.
- **Result:** The concrete Kafka payload published by an agent detailing completion details or failure.

---

## 🧭 Kafka Topic Patterns

Every value below is a preserved legacy Kafka runtime-v1 identifier, not active
Tenvyr branding. The same rule applies to retained Kafka consumer groups and
client IDs in service configuration.

- **Agent Task Topic:** `agentweave.agent.<agent-name>.task` (e.g. `agentweave.agent.code-reviewer.task`)
- **Agent Result Topic:** `agentweave.agent.<agent-name>.result` (e.g. `agentweave.agent.code-reviewer.result`)
- **Orchestrator Lifecycle Events:** `agentweave.orchestrator.execution`
- **Orchestrator Cancellation:** `agentweave.orchestrator.cancel`
- **Token Analytics Topic:** `agentweave.analytics.token_usage`

---

## 📋 Pipeline YAML Schema

The source-of-truth pipeline schema is structured as follows:

```yaml
name: code-review-pipeline
version: "1.0"
description: "Reviews code and checks for runtime anomalies"
steps:
  - id: review
    agent: code-reviewer
    input:
      code: "{{ pipeline.input.code }}"
      language: "{{ pipeline.input.language }}"
    timeout: 30s
    retries: 3
    onFailure: retry # continue | stop | retry
  - id: observe
    agent: observability
    dependsOn: [review]
    condition: "{{ steps.review.result.score < 80 }}"
    input:
      findings: "{{ steps.review.result.findings }}"
      logs: "{{ pipeline.input.logs }}"
```

### Supported Fields per Step:

- `id` (string, required): Unique identifier for the step in the pipeline.
- `agent` (string, required): Target agent name (e.g. `code-reviewer`, `runner`).
- `input` (object, required): Input map. Supports `{{ pipeline.input.key }}` and `{{ steps.stepId.result.key }}` templates.
- `dependsOn` (string[], optional): Prior step IDs that must complete before this step starts.
- `condition` (string, optional): Boolean JS expression evaluated after dependent steps finish.
- `timeout` (string, optional): Timeout string (e.g. `30s`, `2m`, `1h`).
- `retries` (integer, optional): Number of retries on failure (default `0`).
- `onFailure` (enum: `continue` | `stop` | `retry`, optional): Behavior on step failure. Defaults to `stop`.

---

## 🔄 Enums & Response Formats

### Execution Status:

`PENDING` | `RUNNING` | `WAITING` | `COMPLETED` | `FAILED` | `CANCELLED`

### Step Status:

`PENDING` | `RUNNING` | `COMPLETED` | `FAILED` | `SKIPPED`

### API Standard Response:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "meta": {}
}
```

---

## 🎨 Development Conventions & Commands

- **Naming Conventions:**
  - TypeScript: `camelCase` for variables/methods, `kebab-case` for file/directory names.
  - Java: `camelCase` for variables/methods, `PascalCase` for classes/interfaces, `kebab-case` for file/directory names.
- **Frameworks:** NestJS (v10+), Next.js 15 (App Router, Tailwind, Shadcn), Spring Boot (v3+).
- **Package Manager:** `pnpm` (use workspaces).
- **Environment Setup:** Copy `.env.example` to `.env` and fill variables.

### Build and Dev Commands:

- Start infrastructure: `pnpm dev:infra` (Starts Postgres, Redis, Kafka, Zookeeper, Kafka UI)
- Start Gateway: `pnpm dev:gateway`
- Start Orchestrator: `pnpm dev:orchestrator`
- Start Agent Code Reviewer: `pnpm dev:reviewer`
- Start Agent Observability: `pnpm dev:observability`
- Start Frontend: `pnpm dev:frontend`
- Install agent skills: `pnpm skills:install`
- Initialize local CodeGraph: `pnpm codegraph:init`
- Test the TypeScript Worker SDK: `pnpm --filter @tenvyr/worker test`
- Run the TypeScript Worker example smoke test: `pnpm --filter @tenvyr/example-typescript-http-worker test`

---

## 🤖 AI Agent Guidelines (Andrej Karpathy Inspired)

When working on this repository, all AI agents (including Codex, Cursor, Claude, Kiro, Antigravity) **MUST** adhere to these rules:

1.  **Read and Think First:** Before proposing or editing code, read the files, verify class interfaces, and state assumptions.
2.  **Surgical Changes:** Make targeted edits using precise replacement chunks. Do not rewrite entire files.
3.  **Token Budget Management:**
    - Use `./scripts/rtk-compress.sh` to filter and compress terminal outputs, git status, test outputs, or logs before feeding them back to your context.
    - Query symbol files using the CodeGraph index.
4.  **No Placeholders:** All code, mock data, and templates must be fully functioning. Do not leave "TODO" blocks or dummy values.
5.  **Run Verifications:** Always run build, syntax checks, or unit tests after applying changes to ensure correctness.
6.  **Document Mechanics:** When adding a new feature or "mechanic", document it in `docs/agent-rules.md` to ensure future agents inherit the same workflow guidelines.

---

## 🚀 Installed Agent Customizations

### i-have-adhd

Output styling rules for ADHD-friendly responses.
@./skills/i-have-adhd/SKILL.md

### ponytail

Lazy senior dev rules for minimal and efficient code.
@./skills/ponytail/SKILL.md
