---
title: "Review Service Showcase & Demonstration Guide"
status: current
audience:
  - developer
  - operator
  - product
last_verified: 2026-11-17
sources:
  - docker-compose.review.yml
  - scripts/review-showcase.sh
  - scripts/review-smoke.mjs
  - scripts/review-benchmark.mjs
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewController.java
  - docs/architecture/review-service.md
---

# Review Service Showcase & Demonstration Guide

This guide provides a focused walkthrough of the asynchronous code review backend. The demonstration sequence takes ~5 minutes once containers are ready (initial image build and cold tool pulls vary by environment). The showcase runs locally in Docker, requires zero external paid LLM calls, and verifies the complete business lifecycle from submission to human verdict.

## Prerequisites & Environment

- **Host Environment:** Linux or Ubuntu on WSL2.
- **Tools:** Node.js 22+, Git, `tar`, and Docker Compose v2.24+.
- *Note on Build Tools:* Host JDK 17 and Maven are required for local test execution, but the Docker Compose build process contains all necessary JDK/Maven dependencies to build and package container images hermetically.
- *No External Dependencies:* No Kafka, Zookeeper, Node.js backend services, frontend web apps, or paid cloud AI provider keys are required.

## Demonstration Sequence

### Step 1: Initialize the Showcase

Start the self-contained three-container topology (`review-api`, `review-worker`, `postgres`):

```bash
# Optional: Set a custom port if default 8080 is in use
export TENVYR_REVIEW_PORT=18080

# Start containers (binds API to 127.0.0.1:18080)
sh scripts/review-showcase.sh up
```

Runtime credentials and bootstrap configuration are generated under `~/.tenvyr/review-runtime` with strict POSIX permissions (`0700` directory, `0600` secret files). The PostgreSQL database state persists in Docker-managed named volume `tenvyr_review_pgdata` (stored in Docker volume storage, not in the runtime directory). Passwords and tokens are generated dynamically per deployment—no hardcoded default credentials exist.

---

### Step 2: Automated End-to-End Smoke Test

Run the automated verification script to confirm database connectivity, authentication, and worker loopback:

```bash
node scripts/review-smoke.mjs
```

This automated test executes the complete three-actor flow (`submitter_a`, `submitter_b`, `reviewer`):
- Fetches fresh CSRF tokens and establishes authenticated session cookies via `POST /login`.
- Verifies dynamically populated user UUIDs via `GET /api/v1/me`.
- Validates that foreign submitters cannot read another user's submissions (HTTP 404).
- Confirms the default worker operates in offline `MOCK` mode (`evidence.mode: "MOCK"`) without external LLM calls or live code analysis.
- Asserts immutable business audit entries (`SUBMIT` and `DECIDE`; callback evidence resides in the engine inbox).
- Emits safe identity proofs to stdout (actor UUIDs, review ID, and decision ID) without leaking secrets.

---

### Step 3: Observed Workflow & Endpoint Mapping

The automated smoke test (`scripts/review-smoke.mjs`) exercises the complete review workflow across the three bootstrap roles. The sequence maps directly to the following HTTP contracts:

| Step | Endpoint & Method | Actor / Role | Contract & Observed Status |
| --- | --- | --- | --- |
| **1. Session Login** | `POST /login` (form-urlencoded with CSRF) | `submitter_a` (`SUBMITTER`) | Returns `204 No Content`; session cookie established. |
| **2. Actor Identity** | `GET /api/v1/me` | `submitter_a` (`SUBMITTER`) | Returns `200 OK` with user UUID and role. |
| **3. Submit Review** | `POST /api/v1/reviews` (`Idempotency-Key`) | `submitter_a` (`SUBMITTER`) | Returns `202 Accepted` with `Location: /api/v1/reviews/{id}`. Replaying with identical key returns `202 Accepted` with same ID. |
| **4. Report Poll** | `GET /api/v1/reviews/{id}/report` | `submitter_a` (`SUBMITTER`) | Returns `200 OK` once worker delivers results (`score`, `findings`, `evidence.mode: "MOCK"`). |
| **5. Reviewer Login** | `POST /login` (form-urlencoded with CSRF) | `reviewer` (`REVIEWER`) | Returns `204 No Content` with distinct reviewer actor UUID. |
| **6. Human Decision** | `POST /api/v1/reviews/{id}/decisions` (`Idempotency-Key`) | `reviewer` (`REVIEWER`) | Returns `201 Created` with `Location: .../decisions/{decisionId}`. Replaying returns `200 OK` with same ID. Author calling decisions returns `403 Forbidden`. |
| **7. Keyset Audit** | `GET /api/v1/reviews/{id}/audit` | `reviewer` / Owner | Returns `200 OK` with immutable keyset records (`SUBMIT`, `DECIDE`, and `CANCEL` when used; worker callback evidence resides in engine inbox). |
| **8. Isolation Check** | `GET /api/v1/reviews/{id}` | `submitter_b` (Foreign `SUBMITTER`) | Returns `404 Not Found`, enforcing per-user object isolation. |

---

### Step 4: Observability & Metrics

Public health probes are accessible anonymously:

```bash
curl -s "http://127.0.0.1:${TENVYR_REVIEW_PORT:-8080}/actuator/health"
```

Spring Boot Actuator metrics (`/actuator/metrics/*`) require authenticated `REVIEWER` session credentials. Using the exported client helpers from `scripts/review-smoke.mjs`, query the command counters and backlog gauge directly:

```bash
node --input-type=module -e '
import { TestHttpClient, login, reviewer, BASE_URL } from "./scripts/review-smoke.mjs";

const client = new TestHttpClient();
await login(client, reviewer);

const cmdRes = await client.fetch(`${BASE_URL}/actuator/metrics/review.commands`);
console.log("review.commands:", await cmdRes.json());

const backlogRes = await client.fetch(`${BASE_URL}/actuator/metrics/review.backlog`);
console.log("review.backlog:", await backlogRes.json());
'
```

- `review.commands`: Timer pre-registered with fixed tags (`command`: `SUBMIT`/`DECIDE`/`CANCEL`, `outcome`: `success`/`replay`/`conflict`/`invalid`/`error`).
- `review.backlog`: Gauge tracking pending `AWAITING_REVIEW` requests via read-only repository scan.

---

### Step 5: Teardown & Data Retention

When finished, stop the showcase containers:

```bash
sh scripts/review-showcase.sh down
```

`review-showcase.sh down` stops and removes the running containers but strictly preserves the Docker-managed volume (`tenvyr_review_pgdata`) and runtime credentials. Restarting via `sh scripts/review-showcase.sh up` recovers all previous data without data loss.

---

## Retained Legacy Showcase

Tenvyr's legacy multi-agent execution showcase (Kafka adapters, TypeScript/Python worker runtimes, and the Operator Workbench) remains fully operational via:

```bash
pnpm showcase:up
pnpm showcase:smoke
pnpm showcase:down
```

See [docs/operations/supervised-coding-team.md](../operations/supervised-coding-team.md) for details on the legacy multi-agent runtime.
