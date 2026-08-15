---
title: "Self-hosted deployment runbooks"
status: current
audience:
  - operator
last_verified: 2026-08-12
sources:
  - docker-compose.self-hosted.yml
  - scripts/self-hosted/backup.mjs
  - scripts/self-hosted/restore.mjs
---

# Self-hosted deployment runbooks (M11, single owner)

All commands run on the owner-controlled host from the repository root.

## Deployment identity (one documented meaning per key)

- `TENVYR_VERSION` = **releaseVersion** `vMAJOR.MINOR.PATCH` — the image
  tag. It MUST name an existing git tag in this repository: the exact
  approved release. A git short SHA is never a version.
- `TENVYR_SOURCE_REVISION` = **sourceRevision** — the immutable full git
  commit SHA the deployed images were actually built from.

An image tag alone is never proof of an upgrade: a source-build upgrade
proves the checkout is the exact clean release commit, bakes the proven
SHA into the images, verifies it on the running containers, and records
both values in `deploy.env` only after success.

## Install / fresh start

1. `pnpm self-hosted:preflight` — validates docker, free ports
   (5433/3000/3001), disk space, and required config references.
2. Check out the release you want to install:
   `git fetch --tags && git checkout v0.1.0` (the checkout IS the source
   that will be built — see the identity model above).
3. `cp .env.self-hosted.example deploy.env` and fill every value from your
   own secret store (see `docs/operations/self-hosted.md` — references
   only, never checked-in values). Example:
   `POSTGRES_PASSWORD=$(openssl rand -hex 32)`.
4. Record the deployment identity in `deploy.env`:
   `TENVYR_VERSION=v0.1.0` and
   `TENVYR_SOURCE_REVISION=$(git rev-parse HEAD)` (the checked-out release
   commit). Then build the pinned images:
   `docker compose -f docker-compose.self-hosted.yml --env-file deploy.env build`
   (or load prebuilt images tagged `tenvyr-orchestrator:$TENVYR_VERSION`
   whose source provenance you can verify).
5. `docker compose -f docker-compose.self-hosted.yml --env-file deploy.env up -d`
6. `pnpm self-hosted:health` — all services ready; migrations applied.
7. Open <http://127.0.0.1:3000/workbench> and onboard a Runtime Connection
   (below).

## Runtime connections

1. Workbench → Runtime connections → create: pick the runtime kind
   (Codex / Claude / OpenCode / Generic CLI), give the profile a name, and
   reference secrets by environment-variable NAME (never paste values).
2. Test the connection (operator-initiated, rate-limited). A card shows
   Connected / Auth required / Unavailable / Degraded / Revoked with the
   last test time and tested runtime version.
3. Bind the connection to agents via
   `AGENT_TRANSPORT_CONFIG.<agent>.connectionId` and restart the
   orchestrator.
4. Revoke: Workbench card action or
   `POST /api/connections/<id>/revoke` — future claims and pending
   delivery are denied deterministically.

## Backup and restore (drill vs recovery — practice the drill first)

0. Maintenance serialization: only ONE backup/restore/upgrade maintenance
   operation may run at a time (exclusive lock at
   `backups/.maintenance.lock`; a concurrent operation fails fast with
   "maintenance operation already active"). A crashed operation releases
   the lock automatically (dead-owner-PID stale reclaim).
1. `pnpm self-hosted:backup` → writes `backups/tenvyr-<version>-<ts>.dump`
   + `.sha256` + `manifest.json`. The backup is VERIFIED before PASS: the
   dump is restored into an isolated `tenvyr_backup_verify` database and
   ALL manifest anchors (migration ledger fingerprint, table
   inventory/count fingerprint over the complete authoritative 31-table
   set, plan revision hash-ledger fingerprint, execution provenance
   anchor, representative terminal Capsule/export anchor) are computed
   FROM THE RESTORED DUMP — never from the live database. The manifest is
   the RESTORE AUTHORITY; `PASS` means the artifact is already proven
   restorable. A failed verification never leaves a labeled backup.
2. Restore DRILL (verification only — the ACTIVE authority is never
   touched): `pnpm self-hosted:restore backups/tenvyr-...dump --drill`
   — checksum verify, fail-closed manifest contract (checksum triple
   dump == sidecar == manifest, version, sha256 algorithm, verified
   marker, source revision shape, required structural anchors non-null,
   canonical inventory), schema/version check, restore into the isolated
   `tenvyr_restore` database, then DEEP integrity checks that recompute
   the snapshot anchors on the RESTORED database and compare them against
   the BACKUP MANIFEST. The current active database is NOT the authority:
   a legitimate advance of the live database after the backup can never
   invalidate a valid historical backup (drift versus current state is
   reported as informational evidence only). PASS means the backup is
   restorable — it does NOT mean authority was restored.
3. Recovery (explicit, replaces the active authority):
   `pnpm self-hosted:restore backups/tenvyr-...dump --promote` —
   FAILURE-SAFE AND CRASH-SAFE ordering: checksum + manifest contract +
   deep manifest-relative verification ALL complete BEFORE any writer is
   quiesced (a failed backup leaves the deployment untouched and
   healthy); then quiesce writers, swap the authority with deterministic
   automatic rollback (the renames are NOT transactionally atomic — if
   `tenvyr_restore -> tenvyr` fails, `tenvyr_pre_restore -> tenvyr` is
   attempted immediately and the original deployment is restarted and
   proven ready), restart, verify readiness + invariants + Capsule/
   provenance reconstruction, and prove a NEW write through the app API.
   The pre-recovery safety copy `tenvyr_pre_restore` is kept until every
   gate passes; any post-promotion gate failure rolls back to the
   original authority and returns failure — never PASS.
4. CRASH RECOVERY: promotion journals every phase durably
   (`backups/.recovery-journal.json`) BEFORE each destructive database
   step. After ANY process death (e.g. power loss, `kill -9`), the next
   `restore` invocation (drill, promote, or the explicit
   `pnpm self-hosted:restore --reconcile`) reconciles the observed state
   FIRST — before any DROP/rename — and NEVER blindly drops
   `tenvyr_pre_restore`. The original authority is only ever renamed
   back; an unproven candidate is preserved under
   `tenvyr_failed_promotion`; if no safe automatic action exists, the
   exact observed state and phase-accurate recovery commands are printed.
   An interrupted promotion is aborted with "retry explicitly" — resume
   by running the promote again.
5. After ANY restore: rotate deployment secrets, reconnect runtimes
   explicitly (local CLI auth is runtime-owned machine state and is never
   restored), then run a NEW team run to prove the wedge.

## Upgrade

1. `pnpm self-hosted:upgrade <target-version>` — numeric
   vMAJOR.MINOR.PATCH validation (downgrades and no-ops are rejected).
2. The script PROVES the source identity first: the target must be a real
   git tag, the checkout HEAD must BE that tag's commit, and the working
   tree must be clean — arbitrary old source is never rebuilt under a
   newer target tag.
3. It then takes a VERIFIED backup (backup.mjs PASS implies a manifest
   proven against an isolated restore of that exact dump; the upgrade
   holds the maintenance lock and the backup child inherits ownership via
   `TENVYR_MAINTENANCE_OWNED=1`). Any backup failure aborts BEFORE
   compose build/up or any other deployment mutation. After that it FAILS
   CLOSED unless the resolved Compose stack points every Tenvyr service
   at the requested target.
4. It builds the images with the proven source revision baked in
   (`TENVYR_SOURCE_REVISION`), recreates the stack WITH the target,
   waits for readiness, and proves the RUNNING containers carry BOTH the
   requested tag AND the proven source revision — a stale stack or
   unverifiable prebuilt image can never print target-version success.
5. `deploy.env` `TENVYR_VERSION` and `TENVYR_SOURCE_REVISION` are updated
   ONLY after the upgrade is proven; any failure leaves the metadata
   truthful and the backup preserved.
6. If the upgrade is not proven rollback-compatible, the documented
   recovery is RESTORE --promote, not rollback.

## Incidents

- **Restart / host reboot** — `docker compose ... up -d`; outbox/inbox,
  watchdog, coordination, and local-host recovery re-drive work from
  PostgreSQL. No exactly-once runtime execution is claimed.
- **Disk pressure before migration/backup** — preflight fails closed;
  free disk, then retry. Never start a migration with insufficient disk.
- **Migration failure** — the service stops unhealthy; the pre-upgrade
  backup is the recovery. The executable recovery path is:
  `pnpm self-hosted:restore backups/tenvyr-<version>-<ts>.dump --promote`
  (verified above), which restores the known-good authority, restarts the
  stack, and proves a new write before reporting success. Diagnostics are
  bounded and operator-triggered.
- **Revoked runtime** — the loop denies new work at batch admission and
  dispatch; revoke is terminal and audit-recorded.
- **Accidental duplicate service start** — PostgreSQL locks/uniqueness
  preserve authority; no corruption claim is made.
