---
title: "Spring Review Portfolio — proposed specification"
status: planned
audience:
  - developer
  - product
last_verified: 2026-11-11
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ResultInboxService.java
  - backend/agents/src/main/java/io/tenvyr/agents/AgentProcessor.java
  - backend/worker/src/main/java/io/tenvyr/worker/Worker.java
---

# Proposed specification

Read [discovery](DISCOVERY.md) for existing behavior and [plan](PLAN.md) for
ownership. This document chooses implementation behavior; it is not a current
API reference. All new Java package names below use `io.tenvyr.review`.

## Product and boundaries

One organization; local/self-hosted review service; trusted configured Worker.
A submitter sends a source snippet, polls a bounded report, and a different
reviewer records APPROVE or REQUEST_CHANGES. A human verdict is not a statement
that the code is secure. No repository checkout, arbitrary command, user URL,
file path, Git mutation, provider credential, or code execution enters this API.

Keep the original execution state machine, plan snapshots, inbox/outbox,
canonical identities, HMAC headers and SDK protocols. New user-facing API uses
typed records/enums and mapped errors. Existing internal JSON stays at the
engine boundary; do not port every legacy domain to DTOs.

Non-goals: multi-tenancy, public registration, OAuth/JWT issuer, model routing,
agent marketplace, memory/RAG, new scheduler, general workflow builder, durable
Worker storage, new language SDKs, public exposure of legacy management APIs,
automatic merge/push, and a frontend redesign. Process-local Worker state and
at-least-once compute remain explicit limits. Pure review computation is safe
to repeat; paid model calls may repeat after an ambiguous failure.

## Architecture and lifecycle

Approaches considered: (1) embed the existing engine under a small Spring
boundary, (2) call the private execution API from a separate business facade,
or (3) replace the engine with a new Spring implementation. This proposal uses
(1): the existing caller-owned Connection seam makes request/execution writes
atomic. (2) needs a new atomic internal command to avoid uncertain dual writes;
(3) discards the code the user asked to reuse. This is an author-selected
implementation approach, subject to plan review.

```text
session client -> Spring review API -> review tables + existing engine (same JVM)
                                      | shared PostgreSQL transaction
                                      v
                               existing dispatch outbox
                                      -> HTTP review Worker
                                      <- existing signed callback adapter
```

One engine composition and recovery owner per application. Extract the existing
composition without changing legacy Main behavior. The new app does not start
legacy Main, its HTTP server or `ControlRoutes`. No private HTTP call is used
to create executions. No Gateway, Kafka broker, native process host or Node
backend is needed by the new default profile.

Java 17, Maven; new `backend/review-api` uses its own Boot 3.5.16 parent.
Use Web, Validation, JDBC, Security, Actuator, Flyway core/PostgreSQL modules and
Boot test/Security test; versions come from that parent. Keep legacy dependency
management intact. New `backend/review-worker` remains a small plain-Java
module depending on existing agents/worker modules. No Lombok, JPA, MapStruct,
Spring Cloud, custom authentication framework or new message broker.

Use a shared Hikari DataSource, maximum pool size 10, acquisition timeout 2,000
ms, UTC session initialization. `Db.fromDataSource(DataSource)` must borrow and
return pooled connections without owning/closing the DataSource. Spring owns
the pool. Transactions acquire that same connection via DataSourceUtils and
release it through DataSourceUtils; never call `close()` on a borrowed Spring
transaction connection. No dispatch/network work inside the submit transaction.

For new business command transactions, set PostgreSQL LOCAL lock_timeout to
2 seconds and statement_timeout to 5 seconds. New read JdbcTemplate queries use
a 5-second query timeout. Map lock timeout, deadlock, serialization failure and
pool acquisition failure to safe 503 with Retry-After: 1 after rollback. Never
change the global timeout behavior of legacy engine transactions incidentally.

Startup: validate configuration -> base Migrator -> review Flyway -> validate
fixed pipeline and configured Worker -> initialize engine adapters -> recovery
-> admit review traffic/readiness. Migration failure keeps readiness false.
Shutdown: stop admission and drain requests -> stop/drain recovery -> close
adapters and owned sessions -> close pool. A cleanup failure must not skip later
resources. Retain existing shutdown/restart regression checks.

API bind defaults to `127.0.0.1:8080`. Worker defaults to loopback port 8081.
Compose opts into container-wide binding but publishes the API only as
`127.0.0.1:8080:8080`; Worker and PostgreSQL have no host publication. Callback
URLs/credentials are operator configuration, never request fields.

## Data and authority

New schema `tenvyr_review`, fully qualified business SQL; legacy engine remains
in its configured/default schema (`public` in supported showcase).
Flyway owns only review schema/history (`db/review/V1__review_domain.sql`). A
Boot FlywayMigrationStrategy calls `Migrator.migrate(db)` before
`flyway.migrate()`. Do not alter the retained 27 migration resources/ledger,
enable `ddl-auto`, or mix `schema.sql` initialization into the business schema.

V1 tables and required constraints:

| Table | Required data and constraints |
| --- | --- |
| `users` | `id uuid PK`, `username varchar(64) UNIQUE`, `password_hash varchar(255)`, `role varchar(16) CHECK IN ('SUBMITTER','REVIEWER')`, `enabled boolean`; usernames lowercase ASCII `[a-z0-9_.-]{1,64}`; disabled users cannot authenticate |
| `pipeline_bindings` | `version integer PK CHECK version=1`, `pipeline_id uuid UNIQUE FK` to engine pipelines, `definition_hash char(64)`; same definition reuses row, drift fails startup |
| `requests` | `id uuid PK`, `owner_id uuid FK users`, `idempotency_key uuid`, `request_hash char(64)`, `title varchar(160)`, `language varchar(16)`, `code text`, `execution_id uuid UNIQUE NOT NULL FK` to engine executions, `created_at timestamptz`; UNIQUE(owner_id,idempotency_key), CHECK language; code UTF-8 size <=65,536 bytes |
| `decisions` | `id uuid PK`, `request_id uuid UNIQUE FK requests`, `actor_id uuid FK users`, `idempotency_key uuid`, `payload_hash char(64)`, `action varchar(16) CHECK IN ('APPROVE','REQUEST_CHANGES')`, `comment varchar(2000)`, `step_attempt_id uuid FK`, `result_hash char(64)`, `created_at timestamptz`; UNIQUE(actor_id,idempotency_key) |
| `audit` | `id uuid PK`, `request_id uuid FK`, `actor_id uuid FK`, `action varchar(16) CHECK IN ('SUBMIT','DECIDE','CANCEL')`, `operation_key uuid`, `payload_hash char(64)`, `created_at timestamptz`; UNIQUE(actor_id,action,operation_key); no code, credential, report body or comment copy |

Indices: requests(owner_id,created_at DESC,id DESC), requests(created_at DESC,id
DESC), audit(request_id,created_at,id). Foreign keys prohibit accidental source
deletion; no delete API. Code remains private persisted input; do not echo it in
lists/logs/metrics. Detail may return code only to an authorized actor.

The fixed internal pipeline is version 1, name `review-request-v1`, one step
`review` targeting `code-reviewer`, input `code`/`language` from pipeline input,
`retries: 2`, `onFailure: retry`, `timeout: 30s`. Engine authority deadline is
submission time +180 seconds. Copy template syntax from `scripts/smoke-e2e.mjs`.
Validate with PipelineService. Initialize under a PostgreSQL advisory transaction
lock and use the version binding to avoid duplicate pipelines on parallel startup.
Clients cannot submit steps, pipeline IDs, model names or executor selectors.

## State and report contracts

Do not persist a second mutable copy of engine status. Project business status:

| Persisted engine/report/decision facts | API status |
| --- | --- |
| engine PENDING/RUNNING | `PROCESSING` |
| engine FAILED | `FAILED` |
| engine CANCELLED | `CANCELLED` |
| engine COMPLETED, valid selected report, no decision | `AWAITING_REVIEW` |
| same with APPROVE decision | `APPROVED` |
| same with REQUEST_CHANGES decision | `CHANGES_REQUESTED` |
| engine COMPLETED but absent/invalid review result | `FAILED`, error `REVIEW_REPORT_INVALID` |

Choose the successful attempt of logical step `review`; require its committed
result inbox ownership and payload hash. Return no raw engine configuration,
context, callback metadata, secret references, Capsule or unfiltered error.
`ReviewReport(int score,List<String> findings,ReportEvidence evidence)` requires
integer score 0..100, <=50 findings, each nonblank <=1,000 UTF-16 code units,
and report JSON <=65,536 UTF-8 bytes. Evidence has `mode` (`MOCK` or `RUNNER`),
`provider`, `model`, `fallbackUsed`, and `usageSource`, mapped from actual output
metadata; unknown provider/model remain null. Do not infer real analysis or
fabricate observed model identity. Always identify MOCK reports as demo data.

AgentProcessor currently invents scores for malformed/plaintext responses. The
new Worker validates the raw Runner output before that lenient parser can run,
then validates the business output again. Invalid output is a non-retryable
failed AgentResult, not a successful empty/fabricated report. Keep legacy parser
behavior and legacy checks unchanged.

## Authentication and access

Spring Security form login with sessions, `JdbcUserDetailsManager` custom
queries, DelegatingPasswordEncoder (`{bcrypt}` hashes), normal fixation defense.
No public user-management API. An explicit bootstrap option reads a local user
manifest and creates demo users using supplied credentials; absent credentials
fail, existing users are not silently overwritten. Test fixtures are never
production defaults. Normal startup does not run bootstrap unless requested.

Keep CSRF on login/logout and every session-authenticated unsafe API method.
Only the exact signed callback route is exempt. No global CSRF disable, wildcard
CORS, Basic auth fallback, custom JWT, or custom JSON login controller.
Refresh the token after login/logout. API authentication errors are JSON, never
HTML redirects. Session loss after restart requires login again; business state
survives. Cookies are HttpOnly, SameSite=Lax, Secure in the HTTPS deployment
profile. Local HTTP showcase documents its deliberate Secure=false setting.

SUBMITTER can create, list/read/cancel own requests. REVIEWER can list/read all
requests and decide only on another user's completed valid report. REVIEWER
cannot submit; self-decision is rejected even if future roles overlap. Ownership
is resolved from principal username to durable user UUID, never body/query data.
Invisible request IDs return 404 consistently, including report, audit and cancel.
Visible but unauthorized actions return 403; no role switch via request fields.
Apply checks in service/repository paths as well as route matchers. Resolve
current enabled/role state on each business request; an existing session for a
now-disabled user receives 401, and changed roles cannot preserve old privileges.

## HTTP API (new surface only)

All times UTC ISO-8601; IDs UUID. Unknown JSON properties are rejected on these
new DTOs only. Never globally reconfigure the legacy Json.MAPPER.

| Method/path | Contract |
| --- | --- |
| GET `/api/v1/auth/csrf` | Anonymous allowed; `{headerName,parameterName,token}`, `Cache-Control: no-store` |
| POST `/login` | Standard username/password form + CSRF; success 204, failure 401 JSON |
| POST `/logout` | Session+CSRF; 204; invalidate session and token |
| GET `/api/v1/me` | `{id,username,role}`; 401 when anonymous |
| POST `/api/v1/reviews` | SUBMITTER, CSRF, `Idempotency-Key` UUID; `{title,language,code}`; 202 with Location and summary; equivalent replay returns 202 and same request ID |
| GET `/api/v1/reviews?limit=20&after=<cursor>` | Authorized keyset page; limit 1..100; `{items,nextCursor}`; sorted createdAt DESC,id DESC; summaries exclude code/report |
| GET `/api/v1/reviews/{id}` | Authorized detail `{id,title,language,code,status,createdAt,executionId,attemptCount,errorCode,decision}`; bounded safe errors |
| GET `/api/v1/reviews/{id}/report` | 200 typed report after completed valid result (before/after verdict), 409 `REPORT_NOT_READY` otherwise, or `REVIEW_REPORT_INVALID` for invalid terminal output |
| POST `/api/v1/reviews/{id}/decisions` | REVIEWER, CSRF, Idempotency-Key UUID; `{action,comment}`; first 201 with decision Location, equivalent replay 200 same decision |
| POST `/api/v1/reviews/{id}/cancel` | Owner SUBMITTER, CSRF, Idempotency-Key UUID; 200 summary; equivalent replay 200, terminal new command 409 |
| GET `/api/v1/reviews/{id}/audit` | Same visibility as request; limit/after keyset like list, no payload bodies |
| POST `/internal/agent-callbacks/http/code-reviewer` | HMAC only, exact raw-byte delegation to existing HttpAgentAdapter; no session/CSRF requirement; successful handling 204 |

Review list cursor is URL-safe base64 of `{createdAt,id}`; validate decoded size
<=256 bytes, exact properties, timestamp and UUID. Invalid/oversize cursor 400;
never interpolate it into SQL. No total count required. Audit cursor uses the
same ordering values with ASC pagination (createdAt ASC,id ASC), documented in
OpenAPI. Reapply visibility for every page.

Limits: request body <=1 MiB enforced while streaming, not just Content-Length;
title trim then 1..160 UTF-16 units; code nonblank, preserve bytes, <=65,536 UTF-8
bytes; language one of `java`,`typescript`,`python`; decision comment trim,
1..2,000 units. Treat all three languages as input labels, not verified scanner
coverage. Reject invalid JSON/types/unknown properties with 400; body excess 413.

Error body: `{code,message,requestId}` with safe stable messages. 401 anonymous;
403 role/CSRF/self-review; 404 invisible/missing; 409 idempotency mismatch or
state conflict; 503 transient database/capacity unavailability with Retry-After.
No SQL, stack traces, raw code, passwords or provider responses in error text.

## Atomic commands and idempotency

Submission normalizes title/language, preserves code and hashes a Json.object
of exactly those normalized fields with existing Json.hash. Serialize concurrent
requests with the same owner/key using a transaction advisory lock derived from
the full scope (hash collision only causes extra serialization). Recheck unique
row inside the transaction. Existing same hash -> same ID; different hash ->409.
Create execution via materializeExecutionWithManager, request and SUBMIT audit
using that one connection; any failure rolls back all three. No network call.
Committed PENDING execution is started by existing recovery even if the process
dies before returning 202. Never make best-effort post-commit dispatch necessary.

Business decisions are separate from engine dispatch approvals. Lock order for
all new commands: operation-key advisory lock -> request row -> engine's own
lock protocol through its existing methods. Never acquire engine locks then a
review request lock. Decision rechecks current execution/report, actor and key
in the transaction; only one decision per request. Bind decision to committed
attempt ID/result hash. Equivalent replay requires same actor, key, request,
action and normalized comment. Changed payload or another final decision ->409.
Decision+DECIDE audit commit together; it never changes engine terminal state.

Operation advisory lock scope is `(actor UUID, action, Idempotency-Key UUID)`;
SUBMIT uses the owner UUID as actor. For DECIDE and CANCEL, the payload hash
also includes request ID, preventing a key from being replayed against another
request. Hash collision in the advisory-lock identifier only serializes unrelated
commands; durable unique constraints/hash comparisons remain the authority.

Cancel locks request and rechecks status; if still PROCESSING, call existing
cancelExecutionWithManager on the same connection and write CANCEL audit.
Callback/completion may win; after cancellation returns, re-read authoritative
engine state before deciding whether cancellation actually won. If completion
won, rollback the cancellation audit and return 409. Same-key replay returns
the stored outcome. No new cancel of completed/failed/decided work. Any optional
transport cancel notification is after commit and best-effort; this worker's
descriptor may honestly declare cancel=false.

## Verification and claims

Real PostgreSQL is required for rollback, uniqueness, isolation, lock and crash
checks. H2 and mocks cannot close those gates. Missing database is a failure in
the integration profile. New unit and integration tests have separate explicit
runner modes, as defined in [VERIFY.md](VERIFY.md).

Required failure evidence: parallel submit same/different payload, rollback
between engine and business writes, restart before response, duplicate/conflict/
stale callbacks, two final decisions, cancel-vs-result, cross-user UUID access,
disabled user/CSRF, malformed/oversize JSON and Unicode, pool saturation and
SIGTERM drain. No paid credentials or live model calls in CI.

This slice does not close the global External Production Exposure Gate. It
defines access control for the new review surface only; legacy management
surfaces stay private and unexposed. Package release, public deployment and
claims about other surfaces remain outside scope.
