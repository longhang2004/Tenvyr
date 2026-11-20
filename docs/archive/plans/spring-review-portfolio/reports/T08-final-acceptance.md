---
title: "T08 Task Report — Crash/Security Acceptance and Truthful Portfolio Documentation"
status: historical
audience:
  - developer
last_verified: 2026-11-17
superseded_by:
  - docs/architecture/review-service.md
sources:
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewAccessMatrixIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewConcurrencyIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewRecoveryIT.java
  - scripts/review-benchmark.mjs
  - scripts/review-showcase.sh
  - scripts/review-smoke.mjs
---

# T08 Task Report: Crash/Security Acceptance and Truthful Portfolio Documentation

Status: **ACCEPTED** (2026-11-17 Asia/Saigon).
Task acceptance count is **9 of 9 tasks accepted locally** (all tasks T00–T08 accepted).
The plan is completed and archived under `docs/archive/plans/spring-review-portfolio/`.

## 1. Accepted Baseline & Provenance

- Tasks T00 through T08 are accepted locally (9/9 tasks).
- Source and runtime revision SHA: `e7c57dfef2237dc948d71791f5fce111f3600167`.
- Unchanged review Java source files verified: 46 source hashes verified unchanged.
- PostgreSQL database engine: `postgres (PostgreSQL) 16.16`.
- Published loopback API: strictly `127.0.0.1:18080`.
- End-to-end runtime verification: 3-actor automated smoke test (`scripts/review-smoke.mjs`) and documented metrics querying example passed against active containers.
- Persistence and credential stability: Stable 3 user UUIDs, private credential byte hashes, and volume integrity preserved vs T07 (`tenvyr_review_pgdata`, CreatedAt `2026-11-15T19:20:57Z`).
- Teardown and retention: `scripts/review-showcase.sh down` executed with exit code 0, removing 3 owned service containers while preserving database volume, private directory permissions (`0700`), private secret file permissions (`0600`), and benchmark DEMO records (no reset).
- Privacy note: Specific actor IDs, password hashes, bearer tokens, and private credential file contents are omitted from this report.

## 2. Review Integration Matrix & Launcher Contracts

- Combined review test gate executed and PASSED in 10m23s:
  - 89 Surefire tests (44 review-api + 45 review-worker including 13 HTTP loopbacks)
  - 120 real PostgreSQL integration tests across 15 suites
  - Results: 0 failures, 0 errors, 0 skipped.
- New T08 suites verified:
  - `ReviewAccessMatrixIT` (16 tests): Role enforcement, session invalidation on user disable (401), CSRF enforcement (403), foreign request 404 masking, and Unicode/chunked body limits.
  - `ReviewConcurrencyIT` (2 tests): Real Hikari 10-connection pool exhaustion with 2s acquire timeout returning HTTP 503 `Retry-After: 1`, and real PostgreSQL `ACCESS EXCLUSIVE` table lock with 2s lock timeout returning HTTP 503 rollback followed by safe replay creating one binding and audit row.
  - Prior T06 suites (rerun within the full 120 integration tests): Strict row-level lock serialization (`FOR UPDATE`) under concurrent decision and cancel races.
  - `ReviewRecoveryIT` (4 tests): Deterministic recovery: (a) kill before submit transaction commit -> zero bound request/execution rows; (b) kill after commit before HTTP response -> safe replay returns identical request ID and worker recovery executes; (c) worker crash -> natural retry after default 30s deadline; (d) graceful SIGTERM during in-flight 202 -> web admission stops, held DB work drains, active rows commit, and pool closes last. In-memory sessions are discarded; actors must re-login against live PostgreSQL credentials.
- Launcher contract test suite:
  - Command: `node --test scripts/review-showcase.test.mjs`
  - Results: 21 tests, 0 failures, 10.885s elapsed.

## 3. Retained Polyglot Backend & Docker Recovery

- Full retained backend integration command:
  - Command: `sh scripts/backend-checks.sh --integration`
  - Execution time: Started 2026-11-16T17:29:06Z, finished 2026-11-16T17:48:55Z (elapsed 1189s / 19m49s). Log SHA-256: `847def43546010b9486250cc3feffd27977a13fc17e77ce00bdfe71e2df263e8`.
  - Results: Exit code 0, 21 programs passed across 4 SDK processes (`node`, `python`, `java`, `cpp`).
  - Docker recovery tests: 17 tests executed, 0 failures, 0 skipped.
- Supplemental checks & hosted CI:
  - Supplemental development launcher check (`scripts/backend-dev-check.mjs`): Safely refused existing user-owned default stack; recorded as NOT passed and not modified.
  - Hosted CI: Dedicated workflow job `review-workflow` configured in `.github/workflows/release-ci.yml`; not run or pushed to remote CI host.

## 4. Measured 100-Request / Concurrency 4 Admission Benchmark

- Command: `TENVYR_REVIEW_PORT=18080 TENVYR_REVIEW_RUNTIME_DIR="$HOME/.tenvyr/review-runtime" SOURCE_REVISION=e7c57dfef2237dc948d71791f5fce111f3600167 node scripts/review-benchmark.mjs --output docs/_scratch/agy/T08/benchmark-result.json`
- Raw JSON artifact SHA-256: `1f0f3efbad6e453d2dfec35e9d2c7f3207d9353bdc3e7691173e070a762c14cc` (independent recalculation passed).
- Test mode: `MOCK`
- Admission workload & results:
  - Total submissions: 100
  - Concurrency limit: 4
  - Max observed in-flight requests: 4
  - Wall-clock elapsed: 1525.986 ms
  - Observed admission throughput: 65.53 requests/sec
  - HTTP status breakdown: 100 HTTP 202 Accepted, 0 HTTP 503 Service Unavailable (rejection count: 0, rejection rate: 0.0%)
  - Admission latency (nearest-rank percentiles):
    - Min: 42.561 ms
    - Mean: 60.112 ms
    - p50: 54.605 ms
    - p95: 102.088 ms
    - p99: 125.445 ms
    - Max: 147.790 ms
- Asynchronous background worker progression & drain distinction:
  - Bounded inspection snapshot at 5000 ms timeout inspected all 100 accepted submissions: 5 `AWAITING_REVIEW`, 95 `PROCESSING`, 0 `UNKNOWN`.
  - Explicit distinction: This immediate bounded post-submit snapshot reflects in-flight queue progression under configured Worker concurrency (2) and queue capacity (16); it is NOT a claim of completed throughput or an end-to-end drain SLA.
- Benchmark environment:
  - Host OS / Kernel: Linux `6.18.58.1-microsoft-standard-WSL2` (WSL2 on Windows host)
  - Node version: `v24.22.0`
  - CPU count: 12 logical CPUs
  - Docker Server version: `29.8.2`, memory: 7,986,753,536 bytes (~7.44 GiB)
  - PostgreSQL version: `postgres (PostgreSQL) 16.16`
  - Host isolation note: Benchmarking ran on a local development host with Docker Desktop; other user-owned containers were retained. No claim of an isolated benchmarking environment or production capacity SLA is made.
  - State impact: The benchmark creates 100 DEMO records in the database and leaves them intact; no reset was performed.

## 5. Architectural Boundaries, Ceilings & Open Gates

- Default `MOCK` reviewer fixture operates strictly offline; it does not analyze source code or invoke external paid LLMs.
- Worker queue and run execution tracking remain process-local; lease-based worker retries can duplicate compute (no exactly-once compute claim).
- Backlog gauge (`review.backlog`) evaluates candidate submissions via an honest $N+1$ per-request database query scan ceiling.
- Global production exposure gate, package publishing, and live external HTTPS provider credentials remain open boundaries.
