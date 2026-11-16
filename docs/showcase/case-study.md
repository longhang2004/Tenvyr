---
title: "Case Study: Asynchronous Code Review Service & Engine Seam"
status: current
audience:
  - product
  - developer
last_verified: 2026-11-16
sources:
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewService.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewDecisionService.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewRepository.java
  - backend/review-api/src/main/java/io/tenvyr/review/EngineLifecycle.java
  - backend/review-worker/src/main/java/io/tenvyr/reviewworker/StrictReviewRunner.java
  - docs/architecture/review-service.md
  - docs/reference/implementation-status.json
---

# Case Study: Asynchronous Code Review Service & Engine Seam

## Executive Summary & Problem

Enterprise code review workflows require strict auditability, deterministic outcomes, and clear separation of duties. While generic agent orchestration frameworks focus on flexible reasoning loops and multi-agent chats, real-world business systems demand:

1. **Transactional Request Binding:** Submissions must bind the customer request, client idempotency key, and internal execution attempt in one atomic transaction—preventing phantom executions or orphaned client records.
2. **Strict Separation of Duties & RBAC:** Authors must never review or approve their own submissions; session credentials must dynamically validate against live database roles rather than trusting stale session cookies.
3. **Monotonic Terminal States & Race Resolution:** Review decisions (`APPROVE` or `REQUEST_CHANGES`) and owner cancellations must resolve concurrently without corrupting audit ledgers or producing conflicting terminal states.
4. **Crash Resilience:** Ungraceful worker termination or API server restarts must recover uncompleted work naturally without relying on in-memory state or manual database surgery.

Tenvyr solves this by embedding its proven execution engine into a robust **Spring Boot 3 (Java 17)** business facade with a private **Java HTTP Review Worker** and **PostgreSQL 16**.

## What Was Reused vs. What Was Built

Rather than building a greenfield service from scratch or rewriting proven infrastructure, this architecture reuses core foundational assets while building a tailored business layer:

- **Reused Foundational Assets:**
  - **PostgreSQL-Authoritative Engine:** Reused the existing 27 PostgreSQL database migrations, execution engine, lease-based state transitions, outbox/inbox messaging, and crash recovery loop via [ControlPlaneRuntime.java](../../backend/control-plane/src/main/java/io/tenvyr/control/ControlPlaneRuntime.java).
  - **Pooled Connection Seam:** Reused the pooled JDBC abstraction via `Db.fromDataSource`, allowing caller-controlled transactions while preventing connection leaks.
  - **Signed Callback Protocol:** Reused SHA-256 HMAC canonical payload signing, key rotation, and bounded raw body verification from the core HTTP agent adapter.
  - **Polyglot Compatibility:** Retained complete support for TypeScript, Python, Java, C++, and Go worker SDKs alongside legacy Kafka agent adapters.

- **Newly Built Business Layer:**
  - **Spring Boot 3 Application:** Built [ReviewApplication.java](../../backend/review-api/src/main/java/io/tenvyr/review/ReviewApplication.java) and [EngineLifecycle.java](../../backend/review-api/src/main/java/io/tenvyr/review/EngineLifecycle.java) to manage the engine lifecycle cleanly within Spring's `SmartLifecycle` container.
  - **Domain Facade & Services:** Built [ReviewService.java](../../backend/review-api/src/main/java/io/tenvyr/review/ReviewService.java) and [ReviewDecisionService.java](../../backend/review-api/src/main/java/io/tenvyr/review/ReviewDecisionService.java) to govern business rules, keyset pagination, and atomic verdict recording.
  - **Security & RBAC Boundary:** Built [ReviewSecurityConfiguration.java](../../backend/review-api/src/main/java/io/tenvyr/review/ReviewSecurityConfiguration.java) enforcing form-based session login, CSRF rotation, role verification, and raw HMAC exemption.
  - **Dedicated Java Review Worker:** Built an isolated, containerized worker ([ReviewWorkerMain.java](../../backend/review-worker/src/main/java/io/tenvyr/reviewworker/ReviewWorkerMain.java)) executing [StrictReviewRunner.java](../../backend/review-worker/src/main/java/io/tenvyr/reviewworker/StrictReviewRunner.java) in deterministic offline `MOCK` mode (delivering a mock score and diagnostic findings fixture without source code analysis or external LLM calls).

## Why Spring Transactions and a Strict Facade

Distributed transactions and eventual consistency models introduce high complexity and subtle failure modes. By structuring the architecture around a Spring-managed transactional facade backed by PostgreSQL, we achieved:

1. **Transactional Request and Execution Binding:** When a submitter sends `POST /api/v1/reviews`, Spring's transaction boundary binds the review request and internal engine execution onto a single PostgreSQL connection. The review request and engine execution are inserted atomically. If either insertion fails, the entire transaction rolls back, guaranteeing zero orphaned records.
2. **Client Idempotency Without Distributed Locks:** Clients provide an `Idempotency-Key` header. A unique database constraint on `(submitter_id, idempotency_key)` guarantees that retried requests return the original submission record (`HTTP 202 Accepted`), preventing extra request or execution identities (compute retries remain lease-driven without exactly-once worker compute claims). Decision replays similarly return `HTTP 200 OK` on identical retry after initial `HTTP 201 Created`.
3. **Strict Domain Facade:** The presentation layer never interacts with raw engine tables. The business facade projects clean DTOs, validates payload bounds (1 MiB body limit), enforces keyset pagination, and derives report content strictly from verified `APPLIED` inbox rows.

## Concurrency, Races, and Recovery Proofs

The integrity of business decisions relies on deterministic transaction barriers:

- **Decision vs. Cancellation Race Resolution:** If a reviewer attempts to `APPROVE` a review at the exact moment the author submits a `CANCEL` request, PostgreSQL row locks (`SELECT ... FOR UPDATE` on the parent request row) serialize execution. The winning transaction updates the terminal state and appends to the audit ledger; the losing transaction receives HTTP 409 Conflict. Neither action can double-apply or overwrite the winner.
- **Worker Crash & Lease Expiration:** If the review worker crashes mid-execution (or is killed via SIGTERM), the uncompleted execution lease expires after the configured deadline (default 30s). The engine's background recovery runner automatically redelivers the task to an available worker.
- **API Crash & State Durability:** If the API process terminates while a submission transaction is in-flight, PostgreSQL uncommitted state is rolled back cleanly. Replaying the submission re-creates the attempt safely. State is persisted in durable PostgreSQL volumes; in-memory sessions are discarded, requiring actors to re-authenticate against current database credentials.

## Observability and Honest Ceilings

Production systems require transparent observability without introducing performance bottlenecks:

- **Fixed-Tag Command Metrics:** Micrometer Timer `review.commands` pre-registers fixed combinations of command (`SUBMIT`, `DECIDE`, `CANCEL`) and outcome (`success`, `replay`, `conflict`, `invalid`, `error`). High-cardinality metadata (actor IDs, code snippets, tokens) are strictly excluded to protect metric storage.
- **Dynamic Backlog Gauge:** Metric `review.backlog` reports pending `AWAITING_REVIEW` tasks via read-only repository projections. The candidate scan evaluates unreviewed submissions through an explicit $N+1$ query pattern. Rather than claiming theoretical $O(1)$ scaling, this design explicitly documents this honest ceiling.
- **Bounded Resource Allocations:** Tomcat threads (50 max, 50 accept-count), Hikari connections (10 max, 2,000 ms acquisition timeout), and Worker task queues (concurrency: 2, queue capacity: 16) ensure graceful backpressure under load.

## Conclusion

By reusing Tenvyr's PostgreSQL engine and embedding it behind a modern Spring Boot facade, the review service provides a dependable, transactional business backend. It demonstrates that robust enterprise software is best achieved through strict transaction boundaries, deterministic state machines, and transparent architectural limits.
