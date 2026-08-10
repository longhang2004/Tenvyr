---
title: Configuration Reference
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-10
sources:
  - .env.example
  - docker-compose.yml
  - services/gateway/src/main.ts
  - services/gateway/src/app.controller.ts
  - services/orchestrator/src/agent-adapters/agent-transport-config.service.ts
  - services/orchestrator/src/database/database.provider.ts
  - services/orchestrator/src/database/data-source.ts
  - services/orchestrator/src/services/kafka.service.ts
  - services/agent-runner/src/main/resources/application.yml
  - services/agent-runner/src/main/java/com/agentweave/runner/service/LlmService.java
  - docker-compose.showcase.yml
  - examples/typescript-http-worker/src/index.ts
  - examples/python-http-worker/src/main.py
---

# Configuration reference

Values below are variable names and source defaults, never production secret values. `.env.example` is a convenience template; production source code and Compose remain authoritative when it differs.

## Orchestrator

| Variable                             | Requirement and default                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `ORCHESTRATOR_PORT`                  | Optional; defaults to `3001`. The service does not read generic `PORT`.                                     |
| `POSTGRES_HOST`, `POSTGRES_PORT`     | Optional; default `localhost`, `5432`.                                                                      |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | Optional; both default to `postgres` for local development. Supply secrets outside source control.          |
| `POSTGRES_DB`                        | Optional; uses the persistent compatibility default recorded in `.env.example`.                             |
| `TENVYR_DB_MIGRATIONS`               | Optional; migrations run by default. Exact `false` disables startup migration execution.                    |
| `TENVYR_DB_SYNCHRONIZE`              | Disposable development only; exact `true` works only with `NODE_ENV=development`. Always off in production. |
| `KAFKA_BROKERS`                      | Optional comma-separated brokers; defaults to `localhost:9092`.                                             |
| `KAFKA_CLIENT_ID`                    | Optional; legacy compatibility default `agentweave-orchestrator`.                                           |
| `GATEWAY_URL`                        | Optional; defaults to `http://localhost:3000`.                                                              |
| `ORCHESTRATOR_AGENT_NAMES`           | Optional; defaults to `code-reviewer,observability`.                                                        |
| `ORCHESTRATOR_RESULT_TOPICS`         | Optional comma-separated additional result topics; empty by default.                                        |

HTTP agent transport is disabled when `AGENT_TRANSPORT_CONFIG` is absent or blank. When present, it must be a JSON object keyed by exact agent name. Each entry selects `kafka` or `http`; HTTP entries contain the submit URL, time/size limits, and names of environment variables holding bearer/callback secrets.

| Variable                                     | Requirement and default                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TRANSPORT_CONFIG`                     | Optional JSON; blank means every agent uses Kafka.                                                                      |
| `HTTP_AGENT_CALLBACK_BASE_URL`               | Required when any configured agent uses HTTP.                                                                           |
| `HTTP_AGENT_ALLOW_INSECURE`                  | Optional; only exact `true` permits HTTP URLs. Default is HTTPS-only.                                                   |
| `HTTP_AGENT_CALLBACK_MAX_SKEW_SECONDS`       | Optional positive integer; default `300`.                                                                               |
| `HTTP_AGENT_REPLAY_TTL_MS`                   | Optional positive integer; defaults to the clock-skew window in milliseconds and cannot be shorter.                     |
| `HTTP_AGENT_REPLAY_MAX_ENTRIES`              | Optional positive integer; default `10000`.                                                                             |
| Names selected by `tokenEnv` and `secretEnv` | Required only for the corresponding HTTP agent; values are resolved indirectly and must contain the configured secrets. |

## Gateway

| Variable           | Requirement and default                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `GATEWAY_PORT`     | Optional; defaults to `3000`. The service does not read generic `PORT`. |
| `ORCHESTRATOR_URL` | Optional; defaults to `http://localhost:3001`.                          |

The current Gateway source does not consume the `JWT_*`, Redis, or Postgres values listed under the Gateway heading in `.env.example`. They are not current Gateway API configuration.

## Kafka agents

Both `agent-code-reviewer` and `agent-observability` read:

| Variable           | Requirement and default                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `PORT`             | Optional; defaults to `3002` for code reviewer and `3003` for observability. |
| `KAFKA_BROKERS`    | Optional comma-separated brokers; defaults to `localhost:9092`.              |
| `AGENT_RUNNER_URL` | Optional; defaults to `http://localhost:8085`.                               |

Kafka topic, consumer-group, client-ID, database, Docker network, and Java package values retaining `agentweave` are protocol or deployment compatibility identifiers. Do not rename them as branding cleanup.

## Java Agent Runner

| Variable                              | Requirement and default                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `AGENT_RUNNER_PORT`                   | Optional; defaults to `8085`.                                                                                 |
| `KAFKA_BROKERS`                       | Optional; defaults to `localhost:9092`.                                                                       |
| `LLM_PROVIDER`                        | Optional; `mock`, `openai`, `anthropic`, or `ollama`; defaults to `mock`.                                     |
| `LLM_FAILURE_MODE`                    | Optional; `fail` or `mock`. Defaults to `mock` for mock provider and `fail` for a selected real provider.     |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Required and checked for placeholders when their provider is selected; empty by default.                      |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`     | Required nonblank model identifier for the selected provider. Source defaults exist but should be overridden. |
| `OLLAMA_API_URL`                      | Optional; source default `http://localhost:11434`; Compose uses the host bridge by default.                   |
| `OLLAMA_MODEL`                        | Required nonblank model identifier when Ollama is selected.                                                   |

Mock responses are deterministic and labeled with `provider=mock`,
`model=local-heuristic`, and `fallbackUsed=true`. Real-provider responses use
the configured provider/model and `fallbackUsed=false`. If explicit mock
fallback handles a real-provider error, metadata also records the requested
provider. Token counts are currently labeled `usageSource=estimated`.

## Worker examples

The TypeScript and Python examples share the following names:

| Variable                     | Requirement and default                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `TENVYR_WORKER_TOKEN`        | Required bearer token.                                             |
| `TENVYR_CALLBACK_KEY_ID`     | Required callback signing key ID.                                  |
| `TENVYR_CALLBACK_SECRET`     | Required callback HMAC secret.                                     |
| `TENVYR_CALLBACK_ORIGIN`     | Required exact callback origin.                                    |
| `TENVYR_ALLOW_INSECURE_HTTP` | Optional; only exact `true` permits HTTP callbacks.                |
| `TENVYR_WORKER_HOST`         | Optional; TypeScript defaults to `0.0.0.0`, Python to `127.0.0.1`. |
| `TENVYR_WORKER_PORT`         | Optional; defaults to `8080`; `0` requests an ephemeral port.      |

The package README uses `TENVYR_BEARER_TOKEN` as an illustrative application variable. The runnable examples use `TENVYR_WORKER_TOKEN`; neither name is automatically read by the SDK itself because applications construct SDK configuration explicitly.

## Docker Compose, showcase, and frontend

The default Compose file forwards provider selection, failure mode, credentials,
model IDs, and Ollama URL through environment interpolation. The root
`showcase:up` command supplies `mock` unless `LLM_PROVIDER` is explicitly
exported in the invoking shell; a provider value that Compose only auto-loads
from `.env` does not activate a real call. For an exported real provider, an
unset `LLM_FAILURE_MODE` derives `fail`; export `LLM_FAILURE_MODE=mock` only for
an intentional fallback. Never place a live key in a checked-in environment
file.

`docker-compose.showcase.yml` adds the Python Worker and its exact HTTP adapter
entry. `SHOWCASE_WORKER_TOKEN` and `SHOWCASE_CALLBACK_SECRET` have local-only
defaults for the named showcase project; override them for any non-local use.
The default showcase requires no provider credential.

The default Compose file sets generic `PORT` for Gateway and Orchestrator, while
current source reads `GATEWAY_PORT` and `ORCHESTRATOR_PORT`. Fixed container
values still match source defaults, but changing only `PORT` does not reconfigure
those services.

The frontend reads optional `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`; both
default to `http://localhost:3000`. The smoke script separately supports
`SMOKE_GATEWAY_URL`, `SMOKE_ORCHESTRATOR_URL`, `SMOKE_CODE_REVIEWER_URL`,
`SMOKE_OBSERVABILITY_URL`, `SMOKE_RUNNER_URL`, `SMOKE_PYTHON_WORKER_URL`, and
`SMOKE_FRONTEND_URL` overrides, plus readiness and polling timeouts.
