---
title: Review Worker Architecture
status: current
audience:
  - developer
last_verified: 2026-11-14
sources:
  - backend/review-worker/src/main/java/io/tenvyr/reviewworker/ReviewWorkerMain.java
  - backend/review-worker/src/main/java/io/tenvyr/reviewworker/StrictReviewRunner.java
  - backend/agents/src/main/java/io/tenvyr/agents/AgentProcessor.java
  - backend/agents/src/main/java/io/tenvyr/agents/ReviewReportContract.java
  - backend/worker/src/main/java/io/tenvyr/worker/Worker.java
---

# Review Worker Architecture

The Review Worker (`io.tenvyr:review-worker`) hosts the specialized `code-reviewer`
agent behind the standard Java HTTP Worker runtime. It provides strict business report
validation, deterministic fixed-concurrency scheduling, Bearer admission, and HMAC-SHA256
signed asynchronous callback delivery.

## Architecture and Seams

```
HTTP Client (Review API / Orchestrator)
        │
        ▼ POST /v1/runs (Bearer auth, Idempotency-Key)
┌────────────────────────────────────────────────────────┐
│ Worker Runtime (io.tenvyr.worker.Worker)               │
│ - Fixed concurrency (2), queue (16), 1 MiB limit       │
│ - In-memory FIFO admission & idempotency store         │
└───────────────────────┬────────────────────────────────┘
                        │ executeAgent
                        ▼
┌────────────────────────────────────────────────────────┐
│ ReviewWorkerMain Handler Seam                          │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ AgentProcessor ("code-reviewer")                 │  │
│  │ - Prompt interpolation & deadline tracking       │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │ delegate.run                 │
│                         ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ StrictReviewRunner Decorator                     │  │
│  │ - Strict duplicate key & trailing token checks   │  │
│  │ - ReviewReportContract.requireOutput validation   │  │
│  │ - Truthful metadata preservation (MOCK / RUNNER) │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                              │
│         ┌───────────────┴───────────────┐              │
│         ▼                               ▼              │
│   MOCK Delegate                  RUNNER Delegate       │
│   (canned demo fixture)          (bounded httpRunner)  │
└────────────────────────────────────────────────────────┘
                        │
                        ▼ POST /callback (HMAC-SHA256 signed)
Callback Target (Review API / Orchestrator)
```

## Wire Surface and Protocol

- `POST /v1/runs`: Accepts `HttpAgentRunRequestV1`. Validates Bearer authentication and
  `Idempotency-Key` header matching `invocationId`. Returns `202 Accepted` with
  `HttpAgentRunAcceptedV1`.
- `GET /health/live`: Returns `200 {"status":"ok"}`.
- `GET /health/ready`: Returns `200` when running, `503` during startup/shutdown.
- Result delivery: Terminal results are delivered asynchronously to the request's
  `callbackUrl` using HMAC-SHA256 signed POST requests ([existing protocol-v1 callback HMAC headers](../transports/http-agent-adapter-v1.md)).

## Strict Validation Boundary

Unlike legacy `AgentProcessor` paths which fall back to scores 80 or 90 on unstructured
or malformed runner text, `StrictReviewRunner` strictly rejects:
- Plaintext and malformed JSON
- Duplicate keys in JSON payloads
- Trailing tokens after the JSON object
- Non-integral, negative, or > 100 scores
- Missing or malformed findings arrays
- Blank finding strings or strings exceeding 1,000 UTF-16 code units
- Serialized report JSON exceeding 65,536 UTF-8 bytes

Metadata normalization:
- Non-null malformed `data.metadata` fails non-retryably.
- Null legacy metadata is normalized to absence only in `StrictReviewRunner`.
- Upstream `fallbackUsed: true` and configured transport mode truth are preserved without inventing tokens or models.

Any failure causes an immediate non-retryable failure callback (`AGENT_EXECUTION_FAILED`)
with the output completely absent, preventing score fabrication.

## Configuration and Bounds

The worker is configured via environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `TENVYR_REVIEW_WORKER_BEARER_TOKEN` | Admission Bearer token | (required) |
| `TENVYR_REVIEW_WORKER_CALLBACK_KEYS` | JSON map of callback keyId to secret | (required) |
| `TENVYR_REVIEW_WORKER_CALLBACK_ORIGINS` | JSON array of permitted callback origins | (required) |
| `TENVYR_REVIEW_WORKER_ALLOW_INSECURE_HTTP` | Exact `"true"` enables `http://` loopback | `false` |
| `TENVYR_REVIEW_WORKER_MODE` | `MOCK` or `RUNNER` | `MOCK` |
| `TENVYR_REVIEW_WORKER_RUNNER_URL` | Fixed private URL for Runner service | (required for `RUNNER`) |

Worker bounds are strictly enforced:
- Concurrency: `2`
- Queue depth: `16`
- Max request body: `1,048,576` bytes (1 MiB)
- Max response body: `65,536` bytes
- Runner response stream cap: `1,048,576` bytes (1 MiB)

## Process-Local Limitations

1. **Ephemeral State**: Run status, queue position, and idempotency records are stored
   strictly in process memory. A process restart starts fresh; pending runs may recompute
   under a new `runId`.
2. **At-Least-Once Delivery**: On transient callback errors (e.g. 503), the worker
   retries with exponential backoff using the identical serialized bytes and delivery ID.

## Verification and Acceptance

The Review Worker was accepted on 2026-11-14 (Asia/Saigon):
- Combined integration suite (`sh scripts/review-checks.sh integration`): 89 Surefire (44 API + 45 Worker including 13 HTTP loopbacks) + 73 real PostgreSQL ITs pass (0 failures, 0 errors, 0 skips) in 5m24s (finished 2026-11-14T13:27:09Z).
- Canonical review runner commands are registered in root reactor (`backend/pom.xml`).
- Unit runner without DB URL: 89 Surefire tests pass.
- Backend build: PASS (2m50s).
- 9 retained pure programs pass; retained Engine passes 38 real PostgreSQL checks; unchanged Control passes 93 real PostgreSQL/HTTP/restart checks on serial retry with same 120s timeout.
- Focused code review `3c9e97a0-803b-44c0-8022-15ea28b7bcee`: 0 actionable findings.
- Source provenance commit: `a7d66cd` (root `e549485`).
