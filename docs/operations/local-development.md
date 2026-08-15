---
title: Local Development
status: current
audience:
  - developer
last_verified: 2026-08-15
sources:
  - package.json
  - docker-compose.yml
  - docker-compose.no-host-ports.yml
  - examples/typescript-http-worker/package.json
  - examples/python-http-worker/src/main.py
  - sdks/python-worker/pyproject.toml
  - services/agent-runner/pom.xml
---

# Local development

## Requirements

- Node.js 22 or newer with Corepack and pnpm 9, as pinned by package metadata.
- Python 3.11 or newer for the private Python Worker SDK.
- JDK 17 and Maven for the Java Agent Runner release path.
- Docker with Docker Compose. The no-host-ports override requires Compose 2.24 or newer because it uses `!reset`.

Dependency installation may use the network:

```bash
corepack enable
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/pip install -e 'sdks/python-worker[dev]'
```

## Start the stack

### Offline showcase

The portfolio golden path is the shortest complete local run:

```bash
pnpm setup:check
pnpm showcase:up
pnpm showcase:smoke
```

Open <http://localhost:4000/dashboard>. `showcase:smoke` seeds the demo data
automatically (the seed is idempotent); run `pnpm showcase:seed` separately
only to pre-seed before a smoke run. Smoke runs `success` and `retry-once`
through the Python `echo-analyzer` Worker and the Kafka/Java-backed
`quality-gate`, verifies status/runtime/attempt metadata, and prints execution
URLs. The default mock provider requires no key.

`showcase:up` ignores a provider value that Compose only auto-loads from `.env`.
It activates a real provider only when `LLM_PROVIDER` is explicitly exported in
the invoking shell. With a real provider exported and `LLM_FAILURE_MODE` unset,
the Runner derives `fail`; export `LLM_FAILURE_MODE=mock` only for a deliberate,
labeled fallback.

Stop only this Compose project with:

```bash
pnpm showcase:down
```

Use [model-provider configuration](../showcase/using-model-providers.md) for an
optional manual provider run. Live-provider calls are never part of the default
startup or smoke command.

### General development stack

The one-command dev stack starts the infrastructure (Postgres, Redis,
Zookeeper, Kafka, Kafka UI) plus the operational services — orchestrator,
gateway, and frontend — in parallel watch mode:

```bash
pnpm dev
```

Stop everything with `Ctrl-C` — the watch services **and** the Compose
stack are shut down (named volumes are kept, so dev data survives). Run
`pnpm dev:infra:down` only after a hard kill (SIGKILL), which bypasses the
cleanup. If you previously started the full Compose stack
(`pnpm dev:infra`), stop it first (`pnpm dev:infra:down`) — its app containers
hold the host ports the watch services need. `pnpm dev` runs the HTTP Worker
path (orchestrator + gateway + dashboard); the Kafka-path agents
(`pnpm dev:reviewer`, `pnpm dev:observability`) are not included because a
host-run Kafka client cannot reach the Compose broker (it advertises its
docker-internal hostname). Run those agents inside the full Compose stack
(`pnpm dev:infra`).

The root `dev:infra` name is historical: its current implementation starts every service in the default Compose file, not only Postgres, Redis, and Kafka.

```bash
pnpm dev:infra
```

To start infrastructure without application services:

```bash
docker compose up -d postgres redis zookeeper kafka kafka-ui
```

Application services can then run in separate terminals with watch mode:

```bash
pnpm dev:orchestrator
pnpm dev:gateway
pnpm dev:reviewer
pnpm dev:observability
pnpm dev:frontend
```

Run the Java Agent Runner separately when it is not running through Compose:

```bash
cd services/agent-runner
mvn spring-boot:run
```

If Postgres, Redis, or Kafka host ports are already occupied, the checked-in override removes those host publications while preserving container-to-container access:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml up -d --build
```

When only the Postgres port is taken by another project (for example a
second dev database), keep host access instead: the dev Compose Postgres
port is parameterized as `TENVYR_POSTGRES_PORT` (default `5432`). `pnpm dev`
sources `.env` and propagates the value to the watch services automatically:

```bash
# in .env (gitignored) or exported in the shell:
TENVYR_POSTGRES_PORT=5433
pnpm dev
```

Standalone watch services (`pnpm dev:orchestrator`, `pnpm dev:gateway`, ...)
read `POSTGRES_PORT` directly from the shell — export it there when not using
`pnpm dev`.

## Worker examples

Build and start the TypeScript example:

```bash
cp examples/typescript-http-worker/.env.example examples/typescript-http-worker/.env
pnpm --filter @tenvyr/example-typescript-http-worker build
set -a && source examples/typescript-http-worker/.env && set +a
node examples/typescript-http-worker/dist/index.js
```

Start the Python example after installing the Python SDK development extra:

```bash
cp examples/python-http-worker/.env.example examples/python-http-worker/.env
set -a && source examples/python-http-worker/.env && set +a
.venv/bin/python examples/python-http-worker/src/main.py
```

Both examples require callback authentication values. Their checked-in `.env.example` files contain placeholders only. Do not commit populated `.env` files.

## Local ports

| Component                      | Default host port |
| ------------------------------ | ----------------: |
| Gateway                        |              3000 |
| Orchestrator                   |              3001 |
| Code reviewer                  |              3002 |
| Observability agent            |              3003 |
| Frontend                       |              4000 |
| Java Agent Runner              |              8085 |
| Worker examples                |              8080 |
| Postgres / Redis               |       5432 / 6379 |
| Kafka internal / host listener |      9092 / 29092 |
| Kafka UI                       |              8090 |

## Shutdown

Stop foreground services and examples with `Ctrl-C`; the examples own their SIGINT/SIGTERM handling and request graceful Worker shutdown. Stop the default Compose stack with:

```bash
pnpm dev:infra:down
```

Use the same `-f` arguments on `docker compose down` when the stack was started with override files.
