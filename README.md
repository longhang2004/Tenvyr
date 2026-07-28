# Tenvyr — Framework-Neutral Agent Execution Control Plane

**Tenvyr** is an execution control plane that runs outside agent processes. It
owns versioned contracts, dispatch, supervision, security and policy
boundaries, and durable orchestration across framework-neutral workers.

Tenvyr is not an agent framework, prompt-chaining layer, or model-provider
abstraction. It does not replace LangGraph, the OpenAI Agents SDK, CrewAI, or
other agent frameworks; it interoperates with them behind Worker and adapter
boundaries while they continue to own agent internals. It is also not an
observability-only product. Execution state and contracts are authoritative,
while observability is a projection that may be sampled, delayed, unavailable,
or rebuilt without changing an execution outcome.

The current implementation coordinates declarative, condition-based DAGs over
HTTP and Kafka transports. Decoupled services can execute in parallel and in
different languages while the control plane retains responsibility for
routing, retries, timeouts, lifecycle, and failure state.

Future roadmap work may project that authoritative state into OpenTelemetry
and artifact-lineage views. Those projections are not execution truth and are
not implemented by this rename.

---

## 🏛️ System Architecture

```text
       ┌────────────────────────────────────────────────────────┐
       │                 Frontend Dashboard                     │
       │                   (Next.js 15)                         │
       └───────────┬────────────────────────────▲───────────────┘
                   │ HTTP                       │ WebSockets
                   ▼                            │
       ┌────────────────────────────────────────┴───────────────┐
       │                    Gateway API                         │
       │                     (NestJS)                           │
       └───────────┬────────────────────────────────────────────┘
                   │ HTTP Post
                   ▼
       ┌────────────────────────────────────────────────────────┐
       │                   Orchestrator                         │
       │                     (NestJS)                           │
       └─────┬───────────────────▲──────────────────────────────┘
             │ task events       │ result events
             ▼                   │
       ┌─────────────────────────┴──────────────────────────────┐
       │                 Apache Kafka Bus                       │
       └─────┬───────────────────▲───────────────────┬──────────┘
             │                   │                   │
             ▼                   │                   ▼
   ┌──────────────────┐          │         ┌──────────────────┐
   │   Agent Runner   ├──────────┤         │   Code Reviewer  │
   │  (Spring Boot)   │          │         │     (NestJS)     │
   └──────────────────┘          │         └──────────────────┘
                                 │
                       ┌─────────┴──────────┐
                       │   Observability    │
                       │     (NestJS)       │
                       └────────────────────┘
```

---

## 💡 Core Concepts

- **Agent:** Standalone services consuming tasks from the preserved legacy runtime-v1 topic `agentweave.agent.<agent-name>.task` and producing to `agentweave.agent.<agent-name>.result`. The topic namespace is a compatibility identifier, not active branding.
- **TypeScript Worker SDK:** `@tenvyr/worker` hosts an asynchronous HTTP agent with typed handlers, bounded execution, idempotency, and signed callbacks.
- **Pipeline:** Declarative DAG defined in YAML coordinating which agents execute, timeouts, retries, and step logic.
- **Orchestrator:** Reads pipeline definitions, evaluates step conditions, handles step dispatch, and manages failure states.
- **Execution:** A single workflow runtime run tracking step statuses (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED`).

## Former internal name

AgentWeave is the former internal name for Tenvyr. That name is also used by the independent
[`arniesaha/agentweave`](https://github.com/arniesaha/agentweave) project; there
is no affiliation, and the former name is not an active alias for Tenvyr.
Tenvyr packages remain private and must not be published until the owner
completes registry, domain, license, and legal reservations.

See the
[product principles](docs/product/product-principles.md) and
[observability/provenance roadmap](docs/roadmap/observability-provenance-roadmap.md).
The roadmap is future direction; this rename does not implement telemetry,
provenance, dashboard, proxy, or provider instrumentation.

---

## ⚡ Agent Support and Workflow Integrations

This repository includes first-class integrations to optimize AI agent developer environments, saving token context and maximizing performance:

1.  **CodeGraph:** Parses codebase symbol structures into a SQLite index to allow agents to execute fast, token-saving intelligence lookups.
2.  **Awesome Skills Library:** A local catalog of structured agentic guidelines for consistent task execution.
3.  **Claude-Mem Context:** Retains developer decisions and execution metrics across terminal sessions.
4.  **RTK Output Compressor:** CLI proxy utility to compress long outputs (such as test errors or git diffs) by 60–90% before pasting into prompts.

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v20+) & `pnpm` (v9+)
- Java Development Kit (JDK 17+)
- Docker & Docker Compose

### Running Infrastructure

1. Copy the environment variables:
   ```bash
   cp .env.example .env
   ```
2. Start up the core databases and message brokers:
   ```bash
   pnpm dev:infra
   ```
   This launches **PostgreSQL**, **Redis**, **Kafka + Zookeeper**, and the **Kafka UI** (at `http://localhost:8090`).

### Working with Developer Tools

- **Install Agent Skills:** `pnpm skills:install`
- **Initialize CodeGraph Database:** `pnpm codegraph:init`
- **Compress Terminal Outputs:** `./scripts/rtk-compress.sh <command>`
- **Verify packed SDKs externally:** `pnpm verify:package-packs`

---

## 📂 Monorepo Structure

- [services/gateway](services/gateway): REST & Socket.io socket server.
- [services/orchestrator](services/orchestrator): Execution Engine & DAG manager.
- [services/agent-runner](services/agent-runner): LLM prompt template executor.
- [services/agent-code-reviewer](services/agent-code-reviewer): Custom security and code reviewer agent.
- [services/agent-observability](services/agent-observability): Log pattern diagnosis agent.
- [frontend](frontend): Next.js dashboard UI.
- [packages/contracts](packages/contracts): Public TypeScript types and validators for the language-neutral agent protocol.
- [packages/worker](packages/worker): TypeScript HTTP Worker SDK.
- [examples/typescript-http-worker](examples/typescript-http-worker): Runnable typed Worker SDK example.
- [docs](docs): Markdown specifications covering all mechanics, including [Agent Rules](docs/agent-rules.md).
