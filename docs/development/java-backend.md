---
title: Java and Go backend
status: current
audience:
  - developer
  - operator
last_verified: 2026-10-15
sources:
  - backend/pom.xml
  - backend/Dockerfile
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/platform/src/main/java/io/tenvyr/platform/Http.java
  - backend/platform/src/main/java/io/tenvyr/platform/Json.java
  - backend/platform/src/main/java/io/tenvyr/platform/Db.java
  - scripts/backend-build.sh
  - scripts/backend-checks.sh
  - scripts/java-backend.sh
  - .github/workflows/release-ci.yml
---

# Java and Go backend

Default `pnpm dev`, service launch commands, Docker Compose and self-hosted
maintenance commands now select the genuine Java backend and Go process helper.
The candidate integration and full showcase gates passed. Committed-source
cutover and an original-to-Java upgrade must also pass before completion is
recorded; see the [verification record](../reference/backend-migration-verification.md).
PR #7 remains draft while those gates and remote CI are pending.

## Build and launch

Use Java 17+, Maven, and Go 1.23+. The Maven script cleans the reactor before
building, copies the actual runtime dependencies, and builds the Go launcher. It compiles main-based
checks; the check runner executes them separately.

```sh
sh scripts/backend-build.sh
(cd backend/executor-host/native && go test ./...)
sh scripts/backend-checks.sh pure
sh scripts/java-backend.sh control-plane
```

The control plane owns the actual Java engine, authority services, runtime
services, HTTP/Kafka adapter router, provider-management sessions, workspace
reconciliation, and recovery loop. Startup applies the retained TypeORM
migrations before opening the API. Failed startup closes owned resources.
Shutdown stops HTTP admission and recovery, closes transports and provider
sessions, and preserves durable inbox/outbox authority for restart.

`ORCHESTRATOR_HOST` defaults to `127.0.0.1`; container configuration explicitly
opts into `0.0.0.0`. The shared HTTP boundary enables credentialed CORS only for
exact `CORS_ORIGIN` allow-list entries. Unset CORS means no HTTP CORS headers;
wildcard or empty allow-lists fail at startup. Gateway's separate Socket.IO
origin policy retains loopback browser origins by default.

Readiness verifies every expected migration name and timestamp in the current
schema, rather than accepting any nonempty ledger. JDBC reads and writes use UTC
and expose JavaScript-compatible millisecond timestamps. The retained
self-hosted containers use UTC; an existing deployment's timestamp convention
must be checked before cutover.

## Persisted identities

Canonical key comparison uses pinned ICU4J 78.2 with the original en-US
collation, rather than the host JDK's different collation data. The normal
foundation check always verifies all 5,018 retained Node canonical strings and
SHA-256 hashes. Do not regenerate stored hashes to accommodate a new algorithm.

Capsule hashing also preserves the original canonical helper's treatment of
JavaScript `Date` values: non-null attempt terminal dates contribute `{}` to the
hash, while the wire DTO still contains ISO dates. The capsule oracle calls the
original production services against the same PostgreSQL rows and compares the
entire DTO/hash, connections, execution summaries/projection, and Attention.
Worker deliveries are drained first so the two captures observe settled rows. Node is a comparison tool here, not a backend dependency
behind the Java service.

## Real acceptance checks

Prepare the unchanged public SDKs and original comparison implementation:

```sh
pnpm install --frozen-lockfile
pnpm --filter orchestrator build
pnpm --filter @tenvyr/worker build
python3.11 -m venv /tmp/tenvyr-sdk-venv
/tmp/tenvyr-sdk-venv/bin/python -m pip install -e sdks/python-worker
mvn -B -f sdks/java-worker/pom.xml test org.apache.maven.plugins:maven-dependency-plugin:3.9.0:copy-dependencies -DincludeScope=runtime
cmake -S sdks/cpp-worker -B sdks/cpp-worker/build
cmake --build sdks/cpp-worker/build
ctest --test-dir sdks/cpp-worker/build --output-on-failure
```

Run against disposable PostgreSQL and Kafka. Database names must contain
`test`, `scratch`, or `disposable`; schema fixtures clean up their own state.
The operations suite separately creates its own isolated Docker deployment and
refuses to target production resources.

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/tenvyr_backend_test \
TEST_KAFKA_BROKERS=127.0.0.1:9092 \
TENVYR_PYTHON_EXECUTABLE=/tmp/tenvyr-sdk-venv/bin/python \
  sh scripts/backend-checks.sh --integration
```

The runner forwards the required engine integration flag and fails on missing
checks. Its gates include real HTTP security; original TypeORM versus Java up/
down schema and ledger comparison; engine authority; composition and restart;
coordinator/operator commands; all four public SDK processes; gateway protocol
tests and actual Socket.IO v4 clients; Kafka agent delivery/offsets; Worker
HTTP/stress/shutdown; native host HTTP/process execution; and Docker maintenance.
Unavailable infrastructure is a failed gate, never a skipped success.

To run the retained recovery suite directly with Java services and Java
maintenance commands:

```sh
TENVYR_RECOVERY_BACKEND=java node --test scripts/self-hosted/recovery.test.mjs
```

The Node harness is shared test code. In this mode it executes
`scripts/java-backend.sh operations` for backup, restore, reconciliation, and
maintenance, and builds the Java self-hosted Compose profile. It does not call
the original Node maintenance implementation.

The `java-go-backend` CI job builds the SDKs, Go helper, clean Maven reactor,
then runs the complete integration runner with PostgreSQL, Kafka, and Docker.
Local or remote CI results must be reported separately from configured gates.

## Deployment and cutover checks

The default `docker-compose.yml` builds the four backend roles from
`backend/Dockerfile`. Kafka readiness requires a metadata request, rather than
just an open TCP port. API/agent publications use IPv4 loopback; existing
Kafka v1 identities, database name and named volumes remain unchanged.
`docker-compose.java.yml` remains an explicit compatibility overlay.
`docker-compose.self-hosted.yml` is the supported HTTP-only topology.

```sh
node scripts/backend-dev-check.mjs
node scripts/backend-showcase-check.mjs --cutover
node scripts/backend-upgrade-check.mjs
```

The development check boots the actual launcher, frontend and Java services on
disposable ports, touches a source timestamp to prove automatic rebuild/restart,
and proves SIGINT teardown. Node filesystem watches supervise development
only, retaining PostgreSQL/Kafka containers through application reload; production Java services do not invoke Node. The showcase cutover gate requires
a clean committed tree, uses default Compose files, runs success/retry flows,
and checks Java-only processes plus every backend's source revision. The
upgrade gate creates its own clean clone and local-only release tag, starts the
retained original Node implementation, then invokes actual Java upgrade. It
checks the verified backup, untouched migration/plan rows, exact existing
capsule/hash, new writes, running Java processes and recorded source revision.
Test release tags are never published. All stacks/data belong to these checks.

These gates verify repository/default deployment cutover on disposable local
installations. No external production installation or paid provider account is
implied. Native tests execute actual supervised fixture CLIs; live paid model
calls and interactive credential flows require an operator's configured account.

See the [continuation briefing](../plans/active/backend-language-migration/CONTINUE.md)
and [implementation ledger](../reference/implementation-status.json).
