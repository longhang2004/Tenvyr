---
title: "Single-owner self-hosted deployment"
status: current
audience:
  - operator
last_verified: 2026-08-12
sources:
  - docker-compose.self-hosted.yml
  - docker-compose.yml
  - docs/operations/configuration.md
---

# Single-owner self-hosted deployment (M11)

## Supported deployment contract

One owner controls one host/private environment, operating one Tenvyr
control plane and PostgreSQL authority with configured runtime connections.
The supported profile is `docker-compose.self-hosted.yml` and pins:

| Component  | Supported version            | Binding           | Volume                    |
| ---------- | ---------------------------- | ----------------- | ------------------------- |
| PostgreSQL | `postgres:15-alpine`         | `127.0.0.1:5433`  | `tenvyr_postgres_data`    |
| Orchestrator | built from this repo, release tag `TENVYR_VERSION` (vMAJOR.MINOR.PATCH) | `127.0.0.1:3001` | — (DB is authority) |
| Gateway    | built from this repo, release tag `TENVYR_VERSION` | `127.0.0.1:3000` | —            |

## Deployment identity (one documented meaning per key)

- `TENVYR_VERSION` = **releaseVersion** `vMAJOR.MINOR.PATCH` — the image
  tag, and it MUST name an existing git tag in this repository (the exact
  approved release). A git short SHA is never a version.
- `TENVYR_SOURCE_REVISION` = **sourceRevision** — the immutable full git
  commit SHA the deployed images were actually built from. `deploy.env`
  records it alongside `TENVYR_VERSION`; backups record it in the manifest;
  upgrades prove it on the running containers.

An image tag alone is never proof of an upgrade: a source-build upgrade
proves the checkout is the exact clean release commit (tag == HEAD ==
clean tree), bakes the proven SHA into the images, verifies it on the
running containers after recreate, and persists both values in
`deploy.env` only after the upgrade is fully proven. If the repository
lacks a release tag for the requested target, upgrade fails closed and
documents the prerequisite (tag the release commit) — provenance is never
invented.

Trust: trusted host administration and trusted configured local runtimes.
This is NOT tenant isolation, a security sandbox, HA, or internet-safe by
default. Services bind loopback unless the operator explicitly configures a
reviewed private reverse proxy. Kafka/Redis/Java services are included only
where the chosen profile needs them: the HTTP Worker path needs none of
them; the self-hosted profile ships PostgreSQL + Orchestrator + Gateway.

## Data inventory (what every backup must contain)

PostgreSQL is the execution authority and is in EVERY supported backup:
pipelines, configuration, connection revisions, plans, attempts, inbox/
outbox, agent events, policy/budget/approval, coordination state,
artifact-as-reference rows, Capsule export pins, and operator-action audit.
External artifact BYTES and runtime auth state are excluded unless a future
capability owns them. Backups never promise to capture provider sessions;
after host migration, local CLI authentication must be reconnected
explicitly (runtime-owned machine state).

## Secrets — references, never values

- Every secret is a REFERENCE: the compose file consumes env var names
  (`POSTGRES_PASSWORD`, `HTTP_AGENT_CALLBACK_KEYS`, per-runtime
  `secretEnv` names) whose VALUES live in the operator's environment or
  secret files OUTSIDE the repository. Never check in live values.
- Secret classes and lifecycle: control-plane DB password; callback
  signing keys; runtime bearer tokens; runtime auth (runtime-owned machine
  state). Document creation (`openssl rand -hex 32`), storage outside
  source, rotation (change value + restart), revocation (Runtime
  Connection revoke + secret removal), and post-restore replacement
  (restore rotates deployment secrets before reconnecting runtimes).
- Local CLI auth is never backed up; re-authenticate after restore or host
  migration.

## Bootstrap (slice 2)

`pnpm self-hosted:preflight` validates the host (docker, ports, disk,
required config references) without writing anything. Bootstrap generates
`deploy.env` from `.env.self-hosted.example` — references only — and the
operator fills values from their own secret store. No installer framework.

## Backup / restore / upgrade (slice 3)

- `pnpm self-hosted:backup` — VERIFIED backup. A consistent `pg_dump`
  (custom format) is restored into an isolated verification database
  (`tenvyr_backup_verify`, bounded and dropped before/after); ALL manifest
  anchors (migration ledger fingerprint, table inventory/count
  fingerprint over the complete authoritative 31-table set, plan revision
  hash-ledger fingerprint, execution provenance anchor, terminal
  Capsule/export anchor) are computed FROM THE RESTORED DUMP — never from
  the live database — and proven structurally valid. Only then is the
  manifest + checksum finalized and `PASS` printed. A backup that reports
  PASS is ALREADY proven to describe a restorable dump artifact; a failed
  verification removes the staging artifact and never labels it a backup.
  Concurrent writes during backup can never make the verified artifact
  inconsistent.
- `pnpm self-hosted:restore <backup> [--drill|--promote]` — two EXPLICIT
  modes:
  - `--drill` (default) — restore into an isolated `tenvyr_restore`
    database, checksum verify, schema/version check, DEEP integrity
    checks: recompute the snapshot anchors on the RESTORED database and
    compare against the BACKUP MANIFEST. The CURRENT active database is
    NOT the restore authority — a legitimate advance of the live database
    after the backup never invalidates a valid historical backup (drift
    vs current is informational evidence only). PASS/FAIL. The ACTIVE
    authority is never touched; the isolated database is inspection
    evidence only.
  - `--promote` — explicit recovery with FAILURE-SAFE ordering:
    checksum + manifest + deep manifest-relative verification ALL happen
    BEFORE any writer is quiesced, so every pre-swap failure (checksum
    mismatch, malformed manifest, corrupt dump, isolated-DB creation or
    pg_restore failure, anchor mismatch) leaves the original active
    database AND the previously healthy services untouched. After
    verification PASS: quiesce writers (a partial quiesce failure
    restarts both services), then a bounded authority swap with
    deterministic automatic rollback — the renames are NOT
    transactionally atomic (PostgreSQL does not allow
    `ALTER DATABASE ... RENAME` in a transaction), so the swap state
    machine is what makes it failure-safe: `tenvyr -> tenvyr_pre_restore`
    then `tenvyr_restore -> tenvyr`; if the second rename fails,
    `tenvyr_pre_restore -> tenvyr` is attempted immediately and the
    original deployment is restarted, proven ready, and promotion returns
    FAILURE (never success). If rollback itself fails, every database
    copy is preserved and the exact observed state plus bounded operator
    recovery commands are printed. After a successful swap: restart,
    orchestrator + gateway readiness, invariants, representative
    Capsule/provenance reconstruction (where the backup has one), and a
    post-recovery write proof through the app API. The pre-recovery
    safety copy (`tenvyr_pre_restore`) is KEPT until every gate passes
    (one bounded copy, replaced per recovery, never accumulated); any
    post-promotion gate failure automatically rolls back (restored active
    -> bounded `tenvyr_failed_promotion`; safety -> active; restart;
    readiness; invariants) and returns failure — never PASS after a
    failed gate.
- `pnpm self-hosted:upgrade <target-version>` — numeric vMAJOR.MINOR.PATCH
  validation (no downgrade), then PROVEN source identity (the target must
  be a real git tag, HEAD must BE the tag's commit, the tree must be
  clean — arbitrary old source is never rebuilt under a newer target
  tag), then a VERIFIED backup (backup.mjs PASS implies a manifest proven
  against an isolated restore of that exact dump) — any backup failure
  aborts BEFORE compose build/up or any other deployment mutation — then
  FAIL-CLOSED resolution check (the resolved Compose stack must point
  every Tenvyr service at the requested target BEFORE anything is
  mutated), build with the proven source revision baked in + recreate
  WITH the target, readiness, proof that the RUNNING containers carry
  BOTH the requested tag AND the proven `TENVYR_SOURCE_REVISION`,
  invariants, and only then persisting `TENVYR_VERSION=<target>` and
  `TENVYR_SOURCE_REVISION=<sha>` into deploy.env. Any failure leaves
  deploy.env truthful and the backup preserved. Rollback is supported
  only where schema/application compatibility is explicitly proven —
  otherwise restore --promote is the documented recovery. No exactly-once
  runtime execution or zero-downtime upgrade is claimed.

## Health and failure behavior (slice 4)

`GET /health` distinguishes liveness, readiness, migration state,
PostgreSQL, and returns safe reason codes — never secrets or raw errors.
Shutdown stops new work and follows the existing graceful semantics;
restart uses outbox/inbox, watchdog, coordination, and local-host
recovery. Warn/fail closed on insufficient disk for migration/backup.

## Runbooks

- [Install / fresh start](self-hosted-runbooks.md#install)
- [Upgrade](self-hosted-runbooks.md#upgrade)
- [Backup and restore drill](self-hosted-runbooks.md#backup-and-restore)
- [Runtime connection onboarding](self-hosted-runbooks.md#runtime-connections)
- [Incidents: restart, disk, migration failure, revoked runtime](self-hosted-runbooks.md#incidents)

## Non-goals

No public/multi-user authorization, SaaS tenancy, Kubernetes, HA, sandbox,
provider credential backup, artifact-byte backup, telemetry backend, or
package publication. The External Production Exposure Gate stays OPEN.
