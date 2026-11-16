---
title: "T08 Task Report — Crash/Security Acceptance and Truthful Portfolio Documentation"
status: current
audience:
  - developer
last_verified: 2026-11-16
sources:
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewAccessMatrixIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewConcurrencyIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewRecoveryIT.java
  - scripts/review-benchmark.mjs
  - scripts/review-showcase.sh
  - scripts/review-smoke.mjs
---

# T08 Task Report: Crash/Security Acceptance and Truthful Portfolio Documentation

Draft note: [T08.md](T08.md) is the draft wrapper for this report.

Status: **IN PROGRESS (DRAFT ACCEPTANCE)** (2026-11-16 Asia/Saigon).
Task acceptance count is **8 of 9 tasks accepted locally** (T00–T07 accepted; T08 draft verification in progress).

## Current Truthful Facts (2026-11-16)

1. **Accepted Baseline & Provenance:**
   - Tasks T00 through T07 are accepted locally (8/9 tasks).
   - Acceptance provenance HEAD `140390e`; T07 actual runtime `237e8b6` passed two consecutive real Docker `up` / `smoke` / `down` cycles on port 18080 with exact preserved identities (3 user UUIDs), persistent volume (`tenvyr_review_pgdata`), and private credential byte hashes.

2. **Integration Test Matrix (22 New Tests Passed Focused Gates):**
   - Baseline: 89 Surefire tests (44 API + 45 Worker including 13 HTTP loopbacks) + 98 real PostgreSQL ITs across 12 suites pass (0 failures, errors, skips).
   - New T08 Test Suites:
     - `ReviewAccessMatrixIT` (16 tests) and `ReviewConcurrencyIT` (2 tests): Passed collectively in one focused gate. Proves comprehensive role enforcement, session invalidation on user disable (401), CSRF enforcement (403), foreign request 404 masking, Unicode/chunked body limits, and strict row-level lock serialization (`FOR UPDATE`) under concurrent decision and cancel races.
     - `ReviewRecoveryIT` (4 tests): Passed in a separate focused gate. Proves deterministic recovery: (a) kill before submit transaction commit -> zero bound request/execution rows; (b) kill after commit before HTTP response -> safe replay returns identical request ID and worker recovery executes; (c) worker crash -> natural retry after default 30s deadline; (d) graceful SIGTERM during in-flight 202 -> web admission stops, held DB work drains, active rows commit, and pool closes last. In-memory sessions are discarded; actors must re-login against live PostgreSQL credentials.
     - Module Dependencies: Source-only test-scope worker dependency added to `review-api` test scope; NO Java main feature change.
     - Full Gate Status: Full combined review gate PASSED in 10m23s with 89 Surefire tests (44 API + 45 Worker including 13 HTTP loopbacks) and 120 real PostgreSQL ITs across 15 suites (0 failures, errors, skips). Fresh Surefire XML asserted and verified before backend clean. Full retained backend `--integration` check is running serially; benchmark 100-request C4 numbers remain pending.

3. **Polyglot SDKs & Tooling Gates:**
   - Node SDK (199), Java SDK (6), Python SDK (261), C++ (2), and Go (1) currently PASS.
   - Node orchestrator, contracts, and SDK build PASS.
   - Full legacy backend `--integration` + original Node oracle final gate remains pending.
   - Launcher contract tests (`scripts/review-showcase.test.mjs`) pass 21/21 in 10.9s after tiny Git fixture calibration (all assertions preserved).
   - Benchmark script (`scripts/review-benchmark.mjs`) passes offline `--self-check`. Actual 100-request / concurrency 4 empirical numbers are PENDING root execution in WSL; no invented SLA/throughput numbers.

4. **OpenAPI & CI Pipeline:**
   - OpenAPI specification (`docs/reference/review-api.openapi.yaml`) covering 14 paths and 56 refs is YAML-valid; semantic corrections are in progress.
   - Dedicated CI workflow job `review-workflow` added with dedicated PostgreSQL; no Kafka required; all 12 original CI jobs preserved. Nothing pushed to hosted CI yet; no hosted green claim.

5. **Open Boundaries & Ceilings:**
   - Global public exposure gate, release gates, HTTPS live provider integrations, and worker process-local outbox durability remain open boundaries.
   - No claim of exactly-once compute, throughput SLA, or real AI fallback.
   - Fixed Micrometer timer tags (`SUBMIT`, `DECIDE`, `CANCEL` x outcomes) contain zero dynamic identities.
   - Backlog gauge evaluates eligible submissions via an honest $N+1$ per-request scan ceiling.
