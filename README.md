# AgentWeave — Kafka-Native Multi-Agent Orchestration Framework

**AgentWeave** is an open-source, highly observable, polyglot framework for orchestrating multiple specialized AI agents using Apache Kafka as the message event bus. 

It enables developers to model complex workflows as declarative, condition-based Directed Acyclic Graphs (DAGs) defined in YAML. Decoupled microservice agents consume tasks from specific topics and publish results back, allowing for parallel, fault-tolerant, and polyglot execution chains.

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

*   **Agent:** Standalone services consuming tasks from `agentweave.agent.<agent-name>.task` and producing to `agentweave.agent.<agent-name>.result`.
*   **Pipeline:** Declarative DAG defined in YAML coordinating which agents execute, timeouts, retries, and step logic.
*   **Orchestrator:** Reads pipeline definitions, evaluates step conditions, handles step dispatch, and manages failure states.
*   **Execution:** A single workflow runtime run tracking step statuses (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED`).

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
*   Node.js (v20+) & `pnpm` (v9+)
*   Java Development Kit (JDK 17+)
*   Docker & Docker Compose

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
*   **Install Agent Skills:** `pnpm skills:install`
*   **Initialize CodeGraph Database:** `pnpm codegraph:init`
*   **Compress Terminal Outputs:** `./scripts/rtk-compress.sh <command>`

---

## 📂 Monorepo Structure

*   [services/gateway](file:///Users/longhang/personal_repos/AgentWeave/services/gateway): REST & Socket.io socket server.
*   [services/orchestrator](file:///Users/longhang/personal_repos/AgentWeave/services/orchestrator): Execution Engine & DAG manager.
*   [services/agent-runner](file:///Users/longhang/personal_repos/AgentWeave/services/agent-runner): LLM prompt template executor.
*   [services/agent-code-reviewer](file:///Users/longhang/personal_repos/AgentWeave/services/agent-code-reviewer): Custom security and code reviewer agent.
*   [services/agent-observability](file:///Users/longhang/personal_repos/AgentWeave/services/agent-observability): Log pattern diagnosis agent.
*   [frontend](file:///Users/longhang/personal_repos/AgentWeave/frontend): Next.js dashboard UI.
*   [docs](file:///Users/longhang/personal_repos/AgentWeave/docs): Markdown specifications covering all mechanics, including [Agent Rules](file:///Users/longhang/personal_repos/AgentWeave/docs/agent-rules.md).
