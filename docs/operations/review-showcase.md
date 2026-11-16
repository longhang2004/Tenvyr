---
title: Review Showcase Operations and Lifecycle
status: current
audience:
  - developer
  - operator
last_verified: 2026-11-16
sources:
  - docker-compose.review.yml
  - scripts/review-showcase.sh
  - scripts/review-smoke.mjs
---

# Review Showcase Operations and Lifecycle

This document describes how to launch, operate, and verify the self-contained
HTTP review showcase topology.

## Topology and Boundaries

The review showcase runs strictly three container services defined in
`docker-compose.review.yml`:

1. `review-api`: Spring Boot 3.5 application hosting the review API boundary,
   session/CSRF authentication, PostgreSQL migrations, and embedded execution engine.
   Published strictly to loopback `127.0.0.1:8080`.
2. `review-worker`: Plain Java HTTP Worker hosting `AgentProcessor` in `MOCK` mode.
   Unpublished to host; communicates via internal Compose network on port 8081.
3. `postgres`: PostgreSQL 16 database storing engine executions and `tenvyr_review`
   schema. Unpublished to host; state persists in named volume `tenvyr_review_pgdata`.

No Kafka, Zookeeper, Gateway, frontend, Node backend, or paid model calls are
used or required.

## Commands

```bash
# Default binding to 127.0.0.1:8080:
sh scripts/review-showcase.sh up
node scripts/review-smoke.mjs
sh scripts/review-showcase.sh status
sh scripts/review-showcase.sh down

# When host port 8080 is occupied (e.g., host httpd listener), configure custom port:
export TENVYR_REVIEW_PORT=18080
sh scripts/review-showcase.sh up
node scripts/review-smoke.mjs
sh scripts/review-showcase.sh status
sh scripts/review-showcase.sh down
```

## Security and Runtime Directory

The launcher requires a permission-restricted runtime directory outside the
workspace on a POSIX-compliant filesystem (defaulting to `~/.tenvyr/review-runtime`
or configured via `TENVYR_REVIEW_RUNTIME_DIR`).

- Directories with group or world permissions (such as WSL `/mnt/c` workspace mounts with `chmod 777`) and symlinks are rejected fail-closed.
- Private passwords, bearer tokens, and callback secrets are generated with file mode 0600 and parent directory mode 0700. Secrets are never printed.
- Persistent volume `tenvyr_review_pgdata` preserves database data and credentials across restarts; no automatic deletion or reset occurs.
- Existing volumes with missing runtime credentials fail closed to prevent orphaned state or silent credential reset. Failure cleanup removes only newly created containers.
- `down` stops containers while preserving database volumes and credentials.

## Container Build and Lifecycle Architecture

- **Committed Git archive build:** Images are built from committed repository source files (`git archive`) and tagged with source `REVISION` metadata, strictly independent of developer `target/` build directories.
- **Service labels:** Docker Compose automatically assigns canonical `com.docker.compose.project: "tenvyr-review"`, and service containers specify custom label `io.tenvyr.review.owner: "tenvyr-review"`.
- **API restart policy:** `review-api` is configured with `restart: "no"`. If the API crashes, rerun `sh scripts/review-showcase.sh up` to restart it; this prevents an infinite restart loop with retained bootstrap environment variables on an already-bootstrapped database. `postgres` and `review-worker` use `restart: unless-stopped`.
- **Startup and health waits:** `review-showcase.sh up` uses native bounded Compose `--wait` to ensure PostgreSQL readiness and worker/API liveness before proceeding.
- **Port configuration:** Host publish port binds to `127.0.0.1:${TENVYR_REVIEW_PORT:-8080}:8080`. Internal container port 8080, inter-service networking, and callback URLs remain unchanged. Smoke tests automatically derive the default base URL from `TENVYR_REVIEW_PORT` while preserving explicit `TENVYR_REVIEW_BASE_URL` overrides.
- **Identities and smoke proof:** `review-smoke.mjs` verifies three distinct bootstrap users (`submitter_a`, `submitter_b`, `reviewer`) with real CSRF tokens, session cookies, and `/api/v1/auth/me` checks; exact user UUIDs and credentials are preserved across cycles.

## Capacity and Metrics Architecture

- **Bounded capacity:** Configured to Tomcat 50 worker threads / 50 accept-count (`server.tomcat.threads.max: 50`, `server.tomcat.accept-count: 50`), Hikari 10 connections / 2s timeout (`maximum-pool-size: 10`, `connection-timeout: 2000`), and Worker concurrency 2 / queue 16. No high-throughput claims are made.
- **Actuator exposure:** Strictly `health` and `metrics` endpoints are exposed. Public `/actuator/health` provides minimal anonymous liveness/readiness with `show-details: never`.
- **Metrics RBAC:** `/actuator/metrics` is restricted to authenticated `REVIEWER` users (anonymous returns 401, submitter returns 403, disabled user returns 401, demoted user returns 403 via dynamic DB check).
- **Command metrics (`review.commands`):** Low-cardinality Timer tracking `command` (`SUBMIT`, `DECIDE`, `CANCEL`) and `outcome` (`success`, `replay`, `conflict`, `invalid`, `error`), pre-registered with 0.0 baseline at startup. High-cardinality/sensitive labels (actor/request IDs, code, comments, URLs) are strictly excluded.
- **Backlog gauge (`review.backlog`):** Dynamic gauge counting current `AWAITING_REVIEW` requests with verified `APPLIED` matching report and no recorded decision via read-only repository projections. Candidate scanning uses an $N+1$ per-request scan, establishing an honest throughput ceiling rather than an $O(1)$ claim.

## Verification Status

Accepted locally on 2026-11-16 (Asia/Saigon): 89 Surefire tests (44 API + 45 Worker) and 98 real PostgreSQL ITs (including 10 ReviewMetricsIT tests) pass with 0 failures, 0 errors, 0 skipped in 6m47. Root launcher contract tests (`node --test scripts/review-showcase.test.mjs`) pass 21 of 21 tests in 102.5s with 0 failures, verifying Compose configurations for both default 8080 and custom 18080 ports. Independent AGY review `b1fad5be` confirmed 0 open findings with clean bypass audit. Initial candidate `6b206e8` image build succeeded, but host `up` on 8080 was blocked by an existing Windows httpd listener; failure cleanup safely removed new containers while preserving the PG volume and credentials. Resolved via `TENVYR_REVIEW_PORT=18080` in revision `237e8b6`. Two consecutive Docker `up` / `smoke` / `down` cycles executed on revision `237e8b6` on `127.0.0.1:18080` with exit code 0 on all steps, verifying complete end-to-end HTTP review workflow, persisted identical volume CreatedAt timestamp, and unchanged private credential byte hashes without user data reset. T00–T07 accepted 8/9; T08 planned.
