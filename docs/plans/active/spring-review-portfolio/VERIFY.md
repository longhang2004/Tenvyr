---
title: "Spring Review Portfolio — verification gates"
status: planned
audience:
  - developer
  - operator
last_verified: 2026-11-11
sources:
  - scripts/backend-build.sh
  - scripts/backend-checks.sh
  - scripts/backend-database-check.mjs
  - docs/operations/testing-and-verification.md
---

# Verification gates

Commands labeled NEW are deliverables of their owning tasks and do not exist
before those tasks. Never claim they ran during planning. Run from repository
root in Ubuntu WSL2 Bash; use the installed JDK 17/Maven/Node/Go toolchain.

## Existing baseline (T00 onward)

```bash
sh scripts/backend-build.sh
sh scripts/backend-checks.sh pure
node scripts/verify-docs.mjs
node scripts/verify-product-identity.mjs
```

Where disposable PostgreSQL, Kafka, all SDK builds and Docker are configured,
also run `sh scripts/backend-checks.sh --integration` using the prerequisites in
`docs/development/java-backend.md`. This is a required final compatibility gate,
not a mandatory Kafka dependency of the NEW review application. Missing setup
is a reported blocked gate until supplied; it is not a skipped pass.

## NEW focused runner (introduced in T01; extended by later tasks)

```bash
sh scripts/review-checks.sh unit
TENVYR_REVIEW_TEST_DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/tenvyr_review_test \
POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
  sh scripts/review-checks.sh integration
```

`unit`: build/install required reactor artifacts without executing unrelated
SDK suites; run new module's `*Test` cases, including actual Boot dependency
closure canonical/hash/HMAC fixtures. After T05 include review-worker checks.

`integration`: require a database URL whose database name contains `test`,
`scratch` or `disposable`; refuse all others. Run unit checks then Maven
Failsafe `*IT` with the integration profile. Missing URL/database and zero tests
are failures. Keep JUnit/Failsafe test parallelization off in this shared test
database; use unique fixture user/request IDs and never touch a personal database.
Do not rely on `backend-build.sh` to run JUnit: it uses `-DskipTests`.

The script uses Maven reactor selection/build ordering rather than assuming
internal artifacts are installed globally. Unit/integration test counts must
appear in output. Do not enable `failIfNoTests=false` to hide absent review tests.

## NEW showcase (introduced in T07)

```bash
sh scripts/review-showcase.sh up
node scripts/review-smoke.mjs
sh scripts/review-showcase.sh down
```

Use a separate Compose project `tenvyr-review` and dedicated review volume.
The launcher generates local test credentials/secrets into an ignored,
permission-restricted task runtime directory; no committed default passwords
or secret values in logs. The smoke client reads that file without printing
credentials, obtains CSRF, logs in, refreshes token, submits and polls a report,
logs in as a different reviewer, decides and verifies audit. It also logs in as
a second submitter and proves foreign-object denial. Only loopback API is
published. Down never removes database volumes by default.

Report evidence must explicitly say MOCK for the default offline fixture.
No provider key or live paid call is required.

## Failure matrix and owning task

| Case | Required assertion | Owner |
| --- | --- | --- |
| Caller transaction rollback / borrowed connection | review + execution + revision + audit all absent; pool still usable | T00, T04 |
| HTTP callback authentication | signed exact bytes accepted; unsigned/bad timestamp/signature denied; no session needed | T01 |
| Migration startup / schema identity | retained 27 ledger unchanged; review schema once under concurrent startup; drift fails | T02 |
| Authentication / authorization / CSRF | wrong credentials 401, disabled user denied, missing CSRF 403, invisible objects 404, role/self-review 403 | T03, T04, T06 |
| Parallel same owner/key | same payload yields one execution; changed payload conflicts; no orphan execution | T04 |
| Report trust boundary | wrong type/malformed/missing score/findings/oversize output fails; MOCK cannot appear real | T02, T05 |
| Two final decisions | one decision and DECIDE audit; replay returns same; other decision conflicts | T06 |
| Cancel vs signed result | one authoritative outcome; no CANCEL audit if completion wins; replay stable | T06 |
| Crash before response / restart | committed submission recovered without new request; uncommitted submission absent | T08 |
| Worker crash / duplicate/stale callback | bounded retry or explicit FAILED; inbox protects state, no exactly-once compute claim | T05, T08 |
| Body/cursor/Unicode limits | limit boundaries and chunked body excess enforced; stable safe errors | T04, T08 |
| Saturation / shutdown | bounded thread/pool/worker queue; unavailable admission 503; recovery drains before pool close | T01, T07, T08 |

## NEW final acceptance (T08)

```bash
sh scripts/review-checks.sh unit
TENVYR_REVIEW_TEST_DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/tenvyr_review_test \
POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
  sh scripts/review-checks.sh integration
node --test scripts/review-showcase.test.mjs
node scripts/verify-docs.mjs
node scripts/verify-product-identity.mjs
```

Also execute the showcase smoke and complete existing backend integration gate.
Final evidence identifies commit/tree, exact commands, infrastructure, test
counts, mock/live mode and limitations. Load evidence measures submission p50/
p95, observed throughput, pool/queue bounds and rejection rate for a reproducible
100-request/concurrency-4 run; it does not invent an SLA from one laptop run.

Stop when gates pass. Repeat or broaden checks only for changed code, an
unresolved concern or a failure. Do not add a new load framework or CI cluster.
