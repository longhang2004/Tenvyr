# Agent Rules and Mechanics (docs/agent-rules.md)

This file contains the definitive guide for AI agents (Codex, Cursor, Claude, Kiro, Antigravity) working in the **AgentWeave** monorepo. It establishes the "rules of engagement" to maximize execution performance, minimize API token costs, and maintain architectural consistency.

---

## 🧭 Core Directives (Karpathy-Inspired)

AI agents are prone to failure modes such as "hallucination loops", "context overflow amnesia", and "mass file rewrites". To mitigate this:

### 1. The "Think-Before-Code" Ceremony

- **Rule:** Before modifying any file, the agent must declare its design assumptions, trace the affected dependencies, and check if the change requires updating databases or configurations.
- **Action:** Write a brief structured paragraph in your thoughts detailing:
  - What function/class is being edited.
  - Where its dependencies are defined (linked using markdown file links).
  - What side effects are expected.

### 2. Surgical, Contiguous Edits

- **Rule:** Never rewrite entire source code files if you are only changing a few lines or a single block.
- **Action:** Always prefer `replace_file_content` for single contiguous edits and `multi_replace_file_content` for multiple non-contiguous edits. DO NOT overwrite files unless creating a file from scratch.

### 3. Verification Protocol

- **Rule:** Every code modification must be verified for syntax and run-time validity.
- **Action:** Run local linters or build commands (`pnpm build`, `mvn clean compile`) to confirm changes do not break the project.

### 4. Rule-Documentation Loop (Mechanic Registration)

- **Rule:** Whenever a new "mechanic" (a new agent, a new Kafka consumer, a new data store adapter, or a helper tool integration) is added to AgentWeave, the agent **MUST** update this file to document the new mechanic's rules.

---

## 🛠️ Registering a New Mechanic Checklist

Every time you add a new service, agent, or major architectural feature, you must perform these steps:

1.  **Update `CLAUDE.md`:** Add ports, glossary terms, or Kafka topic patterns introduced by the new feature.
2.  **Add System Rules to `docs/agent-rules.md`:** Add a section under "Registered Mechanics" explaining how the feature works, what interfaces it exposes, and guidelines for editing it.
3.  **Create Helper Scripts (if applicable):** Create automated tools in the `scripts/` directory to simplify setup, data fetching, or testing.
4.  **Register with CodeGraph:** Run `scripts/codegraph-init.sh` to update symbol references.

---

## 🔌 Integrated Agent Support Mechanics

The following external agent-support tools are integrated into this monorepo to optimize workflows:

### A. CodeGraph (Local Intelligence Graph)

- **Purpose:** Indexes the monorepo into a SQLite database using tree-sitter. Agents query CodeGraph instead of running slow and expensive `grep` or file listings.
- **Rule:** Check `docs/codegraph.md` for index commands and schema queries. Always query the CodeGraph when looking for symbol definitions.

### B. antigravity-awesome-skills (Structured Agentic Skills)

- **Purpose:** Reusable agent guidelines (e.g. security audits, API design, maven packaging) stored as markdown files in the `skills/` folder.
- **Rule:** Refer to `docs/awesome-skills.md`. Pull relevant skills using `pnpm skills:install` when working on specific domains.

### C. Claude-Mem (Cross-Session Memory)

- **Purpose:** Local long-term memories stored via hybrid search. Solves the context loss when initiating new terminal or chat sessions.
- **Rule:** See `docs/agent-memory.md` to learn how to store and fetch memories of architectural decisions.

### D. RTK (Rust Token Killer)

- **Purpose:** Command proxy that intercepts large outputs and filters them. Reduces token waste from repetitive logs and status dumps by 60–90%.
- **Rule:** Refer to `docs/rtk.md`. Run terminal outputs through `scripts/rtk-compress.sh` when returning output summaries.

---

## Registered Mechanics

### Event-Driven Pipeline Runtime

- **Purpose:** The orchestrator persists pipeline definitions/executions in PostgreSQL, dispatches step tasks to Kafka topics, consumes agent result topics, and pushes execution updates to the Gateway webhook for Socket.IO broadcast.
- **Interfaces:** Task topics follow `agentweave.agent.<agent>.task`; result topics follow `agentweave.agent.<agent>.result`; dashboard clients receive `execution-update` over the Gateway WebSocket endpoint.
- **Rules:** Keep `steps.<stepId>.result.<field>` template semantics stable, preserve the v1 `invocationId` and `stepExecutionId` correlation fields for retry safety, and update `ORCHESTRATOR_AGENT_NAMES` when adding Kafka-backed agents.
- **Verification:** Build the touched NestJS services with `pnpm --filter <service> run build`; compile the Java runner with `mvn clean compile`; use a sample YAML pipeline to verify status transitions and WebSocket updates.

### Agent Invocation Contracts v1

- **Purpose:** Defines the transport-independent, versioned invocation, result, and event payloads shared by the Orchestrator and Kafka-native agents.
- **Interfaces:** Canonical draft 2020-12 schemas are in `contracts/schemas`; TypeScript consumers import types, parsers, structured validation errors, and legacy normalizers from `@agentweave/contracts`.
- **Rules:** New writers emit only schema version `"1"`; Kafka readers continue to normalize legacy tasks/results; top-level extension fields are forbidden and additions belong under `metadata`; never generate random compatibility IDs or change Kafka topic/agent names while editing v1.
- **Verification:** Run `pnpm --filter @agentweave/contracts test`, the Kafka service specs for the Orchestrator and both specialized agents, then `pnpm -r build`.

### AgentAdapter Boundary

- **Purpose:** Keeps orchestration state, retries, timeouts, and DAG progression independent from Kafka transport details.
- **Interfaces:** `EngineService` injects `AGENT_ADAPTER`; `KafkaAgentAdapter` implements dispatch/result delivery over the low-level `KafkaService`; `AgentResultService` applies canonical results through the existing Engine state-transition boundary.
- **Rules:** Application services must not import Kafka infrastructure; only the composition root binds the adapter; adapters must not create invocation IDs, update the database, or decide orchestration retries.
- **Verification:** Run the Orchestrator adapter/result/architecture specs and confirm `services/orchestrator/src/architecture.spec.ts` rejects direct Kafka dependencies.

### Asynchronous HTTP Agent Transport

- **Purpose:** Lets exact operator-configured agents receive canonical invocations through `POST /v1/runs` and return canonical results through a signed callback, while all other agents remain Kafka-backed.
- **Interfaces:** `AgentAdapterRouter` selects transport only from `invocation.target.agent`; `HttpAgentAdapter` requires `202 HttpAgentRunAcceptedV1`; callbacks use `POST /internal/agent-callbacks/http/:agent` with HMAC-SHA256 over `<timestamp>.<deliveryId>.<rawBody>`.
- **Rules:** URLs and secret references come only from startup configuration; never route from pipeline input, log secrets/signatures/raw bodies, add automatic fallback, or bypass `AgentResultService`. Keep `AgentAdapterLifecycle` as the sole lifecycle owner.
- **Verification:** Run the HTTP contract, configuration, HMAC, router, callback, architecture, and loopback integration specs; the loopback specs require permission to bind ephemeral `127.0.0.1` ports.

### TypeScript Worker SDK

- **Purpose:** Hosts a typed HTTP agent through `@agentweave/worker`, using bounded local concurrency, FIFO queuing, in-memory idempotency, cooperative deadlines, and HMAC callback retry.
- **Interfaces:** Consumers use only the package root API; the worker exposes `POST /v1/runs`, `GET /health/live`, and `GET /health/ready`; wire behavior is shared through `contracts/conformance`.
- **Rules:** Keep the package dependent only on the public `@agentweave/contracts` API and Node primitives. Preserve raw direct handler returns, exact callback-origin checks, bearer-before-body processing, one-shot lifecycle, and serialized-once callback bytes. Do not add framework, Orchestrator, Kafka, database, model SDK, signal-handler, or persistent-store dependencies.
- **Verification:** Run contracts conformance, Worker unit/integration/architecture/public-consumer suites, the example smoke test, and the Orchestrator loopback integration spec. Port-binding tests require permission for ephemeral `127.0.0.1` listeners.

### Node Test Setup

- **Purpose:** Provides a per-service Jest + ts-jest runner for the four NestJS services (`gateway`, `orchestrator`, `agent-code-reviewer`, `agent-observability`) so the Workspace_Test_Command `pnpm -r test` passes. `agent-code-reviewer` additionally carries `fast-check` for property-based tests (it is the only service hosting property tests).
- **Interfaces:** Run a single service's tests with `pnpm --filter <service> run test`; run every service's tests with `pnpm -r test`. Each service owns a self-contained `jest.config.js` (`preset: 'ts-jest'`, `testEnvironment: 'node'`, `rootDir: 'src'`, `testRegex: '.*\\.spec\\.ts$'`). Tests build a NestJS `TestingModule` with mocked providers only — no Postgres, Kafka, or Socket.IO bootstrap occurs.
- **Rules:** Adding test (or any) devDependencies to a service `package.json` invalidates `pnpm-lock.yaml`, so you MUST refresh the lockfile with a normal `pnpm install` at the repo root afterward; this keeps the later `pnpm install --frozen-lockfile` verification step passing.
- **Verification:** `pnpm -r test` exits `0` with passing suites reported for all four services.

### Docker Host-Port Override (Port_Override_Mechanism)

- **Purpose:** Lets you run the full stack when host ports `5432` (Postgres), `6379` (Redis), or `9092` (Kafka) are already occupied, without editing `docker-compose.yml`.
- **Interfaces:** Default (unchanged) startup is `docker compose up -d --build`. To disable infra host publishing, layer the override file: `docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml up -d --build`. The override file sets `ports: !reset []` on the `postgres`, `redis`, and `kafka` services, removing host publishing while the containers remain reachable to other services over the internal `agentweave-net` network.
- **Rules:** Requires Docker Compose v2.24+ (for the `!reset` merge tag). Do not modify `docker-compose.yml`; the default `docker compose up -d --build` developer experience must remain unchanged.
- **Verification:** `docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml config` shows the `postgres`, `redis`, and `kafka` services with no published host ports.

### Smoke / End-to-End Verification (Smoke_Verification)

- **Purpose:** Provides a repeatable black-box end-to-end check that the running stack drives a sample pipeline all the way to a `COMPLETED` terminal state.
- **Interfaces:** Run `pnpm run smoke:e2e` (an alias for `node scripts/smoke-e2e.mjs`); requires Node 18+ for the built-in global `fetch`. The script health-checks gateway `:3000`, orchestrator `:3001`, code-reviewer `:3002`, observability `:3003`, and agent-runner `:8085` (all via `/health`), plus the frontend `:4000/` and `:4000/dashboard` routes, then creates a sample pipeline, triggers an execution, and polls to a terminal state with a bounded 120s timeout. It exits `0` only on `COMPLETED`, with distinct non-zero exit codes for health, create, trigger, `FAILED`, and timeout failures. Base URLs can be overridden via `SMOKE_*_URL` environment variables.
- **Rules:** Run against an already-started stack (use the Port_Override_Mechanism above if infra host ports are occupied). Stop and remove any temporary containers afterward with `docker compose ... down`.
- **Verification:** With the stack up, `pnpm run smoke:e2e` prints `COMPLETED` and exits `0`.
