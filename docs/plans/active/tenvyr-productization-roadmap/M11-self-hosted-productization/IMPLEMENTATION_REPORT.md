---
title: "Tenvyr M11 Implementation Report: Single-Owner Self-Hosted Productization"
status: planned
audience:
  - product
  - operator
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/EXECUTION_STATUS.md
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/VERIFY.md
---

# M11 Single-owner self-hosted productization — implementation report

Provisional implementer report. Sol audits closure; this document cannot
write `PASS`, `SAFE TO CLOSE`, or `CLOSED`.

## Implemented

- **Supported deployment contract** (`docker-compose.self-hosted.yml` +
  `docs/operations/self-hosted.md` + `scripts/self-hosted/contract.test.mjs`,
  7 assertions): one owner, one host, one control plane + PostgreSQL
  authority; pinned versions (postgres:15-alpine, redis:7-alpine,
  `TENVYR_VERSION` image tags); loopback-only bindings by default; named
  volumes; startup order + healthchecks; data inventory (every backup
  contains the authority: plans, attempts, inbox/outbox, policy/budget/
  approval, coordination, artifacts-as-references, audit); explicit
  non-goals (no HA/Kubernetes/sandbox/public auth).
- **Secrets as references**: `.env.self-hosted.example` is references-only
  (contract test proves no values); compose consumes env names
  (`POSTGRES_PASSWORD`, `HTTP_AGENT_CALLBACK_KEYS`, runtime `secretEnv`
  names); secret classes + creation/storage/rotation/revocation/
  post-restore replacement documented; local CLI auth is never backed up.
- **Bootstrap/preflight** (`pnpm self-hosted:preflight`): docker
  reachability, required references present (values never inspected),
  compose contract (no public binds, no `:latest`), free ports, disk
  fails-closed; `--upgrade` target validation. Writes nothing.
- **Verified backup/restore/upgrade** (`pnpm self-hosted:backup|restore`):
  consistent custom-format pg_dump with checksum + version label +
  manifest; restore verifies checksum + version, restores into a clean
  isolated target, runs post-restore invariants, and documents secret
  rotation + runtime reconnection as the next step. Upgrade = preflight →
  verified backup → ordered migrations once → readiness/invariants; a
  failed migration stops unhealthy and preserves the backup; restore is
  the documented recovery unless rollback compatibility is proven.
- **Migration-failure rollback proof** (Postgres test): an injected
  failing migration leaves no partial table and no ledger trace.
- **Backup/restore round-trip proof** (Postgres test + two container
  drills): identities (execution id, input), audit facts, coordination
  runs, and the migrations ledger survive; the restored authority accepts
  new writes.
- **Readiness health** (`GET /health`): liveness vs readiness with safe
  reason codes (`ready` / `migrations-required` / `postgres-unreachable`);
  never secrets or raw errors.
- **Runbooks** (`docs/operations/self-hosted-runbooks.md`): install,
  upgrade, backup/restore drill, runtime connection onboarding, incidents
  (restart, disk, migration failure, revoked runtime, duplicate start).

## Product outcome

A single owner can repeatably operate the closed wedge on one host: run
preflight, fill references from their own secret store, bring up the
loopback profile, onboard and test Runtime Connections, launch supervised
team runs from the Workbench, back up the authority with a checksummed
version-labeled dump, restore into a clean target, upgrade through ordered
migrations with a verified backup first, and follow runbooks for incidents.
No public bindings, no checked-in secrets, no untested restore claims, no
hidden HA/sandbox semantics; the External Production Exposure Gate stays
OPEN.

## Architectural decisions and deviations permitted by SPEC

- The self-hosted profile includes PostgreSQL + Redis + Orchestrator +
  Gateway only (the HTTP Worker path needs no Kafka); the development/
  showcase profiles are unchanged.
- `pg_dump`/`pg_restore` run inside the postgres container (no host-side
  postgres tooling dependency).
- The M11-S4 health endpoint extends the existing `GET /health` shape
  additively (`ready`, `reasonCode` added; `status`/`service` unchanged).

## Verification evidence

- Contract test 7/7; orchestrator unit 662 passed; gateway 4/4; frontend
  safe-preview 2/2, lint + typecheck clean.
- Real-PostgreSQL suite: 959 passed, run twice sequentially (incl.
  M11-S3 migration-failure rollback + backup/restore round-trip).
- Two clean restore drills against the real postgres container: empty and
  seeded (1 execution + 17 migrations + coordination runs) round-trips
  with identities intact.
- `pnpm test:all`, `pnpm build:all` green; showcase:up + smoke PASS (the
  showcase gates also fixed four production boot bugs — missing
  coordinator provider, DI default-param, missing @Inject tokens,
  gateway asset copy); docs 20/20, verify-docs (120 files, 228 links, 61
  current, 42 capabilities), identity 25/25, `git diff --check` clean.

## Limitations

- M11 is `READY FOR INDEPENDENT SOL VERIFICATION`; M8–M10 Sol reviews are
  still pending at owner direction (recorded in EXECUTION_STATUS).
- No prior-version upgrade drill was run (no published prior version); the
  upgrade path is documented and the migration machinery is proven.
- Design-partner evidence: 0 interviews; nothing promoted without real
  evidence. External Production Exposure Gate stays OPEN.

## Closure hardening (2026-08-14, implementer)

- Semantic version comparison is NUMERIC (major, then minor, then patch)
  — the JS array-relational trap is gone; downgrade rejection now holds
  for minor/patch differences (v1.2.0 vs v1.10.0).
- Upgrade target propagation: `pnpm self-hosted:upgrade <target>` passes
  TENVYR_VERSION=<target> into the Compose environment (shell env beats
  --env-file), FAILS CLOSED unless the RESOLVED config points every
  Tenvyr service at the target BEFORE mutation, recreates the stack WITH
  the target, waits for readiness, and proves the RUNNING container
  images target the requested version before printing success.
  deploy.env TENVYR_VERSION is persisted ONLY after the upgrade is
  proven — failed upgrades leave deployment metadata truthful.
- Restore is explicitly split: `--drill` (isolated `tenvyr_restore`
  verification database; the active authority is never touched; PASS
  means the backup is restorable, not that authority was restored) and
  `--promote` (explicit recovery: quiesce writers, restore + DEEP
  integrity checks against the active authority — row equality across
  the full data inventory, migration ledger, plan revision hash ledger,
  known execution identity — then atomic rename promotion with the
  pre-recovery active database preserved as the bounded
  `tenvyr_pre_restore` safety copy (one copy, replaced per recovery),
  restart, readiness, invariants, and a post-recovery write proof through
  the app API).
- The migration-failure incident runbook now names the executable
  recovery path (`restore --promote`) instead of "restore the backup".
- Contract tests cover all of the above executably (17 tests), including
  the required `v1.10.0 > v1.2.0`-style comparisons and target
  propagation resolution.

## Closure hardening 2 (2026-08-14, implementer)

- ONE deployment identity model: `TENVYR_VERSION` = releaseVersion
  (vMAJOR.MINOR.PATCH, the image tag, MUST name a real git tag — the
  exact approved release) and `TENVYR_SOURCE_REVISION` = sourceRevision
  (the immutable full git commit SHA the images were built from). The
  install runbook no longer uses a git short SHA as a version.
- A source-build upgrade PROVES the source before anything is built:
  the target must be a real tag, HEAD must BE the tag's commit, and the
  working tree must be clean (missing tag / HEAD mismatch / dirty tree
  all fail closed before any stack mutation, with the tag-as-prerequisite
  documented). The proven SHA is baked into the images
  (`--build-arg TENVYR_SOURCE_REVISION`, Dockerfiles ARG/ENV), verified
  on the RUNNING containers after recreate (image tag alone is never
  sufficient proof), and persisted in deploy.env alongside
  TENVYR_VERSION only after the upgrade is fully proven.
- Backups REQUIRE source provenance and the manifest is now the RESTORE
  AUTHORITY: backup captures bounded snapshot anchors (migration ledger
  fingerprint, table inventory/count fingerprint, plan revision
  hash-ledger fingerprint, execution provenance anchor, representative
  terminal Capsule/export anchor) via the shared `anchors.mjs`; restore
  recomputes the anchors on the restored snapshot and compares against
  the MANIFEST. The current active database is NOT the restore authority
  — a legitimate advance of the live database after the backup never
  invalidates a valid historical backup (drift vs current is
  informational evidence only). Old manifests without anchors fail
  closed (retake the backup).
- Disposable historical-recovery E2E (`pnpm self-hosted:recovery-test`):
  state A -> backup A -> live B -> drill A PASS (manifest-relative;
  would FAIL pre-fix) -> promote A -> promoted identity == A with B
  absent -> readiness -> new post-recovery write. Refuses to run when
  real infrastructure is present; teardown removes all disposable
  containers/volumes/artifacts.

## Closure hardening 3 (2026-08-14, implementer)

- VERIFIED backup invariant: `self-hosted:backup` reports PASS only after
  the dump was restored into an isolated verification database
  (`tenvyr_backup_verify`, bounded, dropped before and after) and ALL
  manifest anchors were computed FROM THE RESTORED DUMP — never from the
  live database — and proven structurally valid (migration ledger, full
  31-table inventory counts, plan hash ledger all readable). A failed
  verification removes the staging artifact and never labels it a backup;
  concurrent writes during backup can never make the verified artifact
  inconsistent, because the manifest describes the dump itself.
- Complete authoritative backup inventory: `pipelines` and
  `plan_proposals` added (31 tables, matching the entity and migration
  inventories exactly); a regression compares `anchors.mjs TABLES`
  against the TypeORM entity inventory and the migration CREATE TABLE
  inventory so a future application authority table cannot be silently
  omitted.
- Restore ordering is failure-safe: `--promote` completes checksum +
  manifest + deep manifest-relative verification BEFORE any writer is
  quiesced; every pre-swap failure leaves the original active database
  and the previously healthy services untouched (a partial quiesce
  failure restarts both services). The authority swap is an explicit
  state machine with deterministic automatic rollback — the renames are
  NOT transactionally atomic (PostgreSQL does not allow ALTER DATABASE
  RENAME in a transaction): `tenvyr -> tenvyr_pre_restore` then
  `tenvyr_restore -> tenvyr`; a failed second rename immediately attempts
  `tenvyr_pre_restore -> tenvyr`, restarts the original deployment, and
  returns promotion failure. A rollback failure preserves every database
  copy, prints the exact observed state and bounded operator recovery
  commands, and never claims success.
- Post-promotion gates are rollback-safe: the pre-recovery safety copy is
  kept until service start, orchestrator readiness, gateway readiness,
  invariants, Capsule/provenance reconstruction (where the backup has
  one), and the post-recovery write proof all pass; any gate failure
  automatically rolls back (restored active -> bounded
  `tenvyr_failed_promotion`; safety -> active; restart; readiness;
  invariants) and returns failure — never PASS.
- Fault injection: bounded one-shot `TENVYR_RESTORE_FAULT` hooks
  (`second-rename`, `rollback-rename`, `post-gate-readiness`) drive real
  E2E tests: concurrent-write backup consistency (PASS -> immediate drill
  PASS), invalid-backup promotion safety (corrupt dump and
  manifest-inconsistent backups fail before quiescing), second-rename
  automatic rollback, rollback-failure recovery commands (the printed
  commands are executed by the test and repair the deployment), and
  post-promotion gate rollback.
- Upgrade depends on a VERIFIED recovery artifact: `upgrade.mjs` aborts
  before compose build/up on any backup failure (regression-tested with
  injected git + failing backup seams); the deployment identity model
  (TENVYR_VERSION release tag + TENVYR_SOURCE_REVISION immutable SHA) is
  unchanged from closure hardening 2.
- Hosted CI: a real-PostgreSQL job (disposable service container) runs
  the integration suite TWICE on reinitialized state with a no-silent-
  skip guard (`scripts/assert-jest-run.mjs`), a required self-hosted
  contract gate, and a required disposable recovery E2E job; live
  provider/CLI gates stay opt-in (`TENVYR_LIVE_RUNTIME_GATES=0`).
- Docs updated to describe the ACTUAL ordering and failure behavior; the
  "atomic renames" prose is replaced by the honest state-machine
  description. M8/M9/M10 are recorded as accepted by independent Tech
  Lead review. M11 is NOT closed — closure remains the Technical Lead's
  decision.

## Closure hardening 4 (2026-08-14, implementer — crash-recoverable recovery)

- CRASH-RECOVERABLE PROMOTION: `restore --promote` now writes a durable
  phase journal (`backups/.recovery-journal.json`) BEFORE every
  destructive database step: `verify-done -> quiescing ->
  swap-active-to-safety -> swap-verified-to-active -> post-gates ->
  complete`. A process death at ANY phase (before quiesce, after quiesce,
  after active->safety, after candidate->active, during post-promotion
  gates, after gates before the completion marker) leaves the journal +
  the database names as the unambiguous record; the NEXT recovery
  invocation (drill, promote, or the new `--reconcile` mode) reconciles
  the OBSERVED state BEFORE any destructive DROP/rename. The original
  authority is never silently deleted: `tenvyr_pre_restore` is only ever
  renamed back (`restore-original`) or, when the second rename already
  ran, the unproven candidate is preserved under the bounded
  `tenvyr_failed_promotion` name while the original is restored
  (`rollback-candidate`). An interrupted promotion is conservatively
  undone (original restored, deployment restarted + readiness +
  invariants proven) and the new operation aborts with an explicit
  retry-required result — never resumed blindly. A fully completed
  recovery writes the durable `complete` marker BEFORE printing PASS, so
  a retained safety copy is distinguishable as a completed artifact
  (replaced at the next recovery) rather than an interrupted one. Real
  SIGKILL fault hooks (`crash-after-first-rename`,
  `crash-after-promotion`) drive the E2E crash tests; the pure
  `planReconciliation` decision table is contract-tested for every phase.
- MAINTENANCE MUTUAL EXCLUSION: every backup/restore (drill/promote/
  reconcile) acquires an exclusive process-lifetime lock
  (`backups/.maintenance.lock`, owner PID + startedAt); a concurrent
  operation FAILS FAST with "maintenance operation already active"
  instead of interleaving the shared bounded resources
  (`tenvyr_backup_verify`, staging dump paths) or the authority-swap
  names. Crash-release: a dead owner PID makes the lock stale and the
  next acquisition reclaims it. `upgrade` owns the lock for its whole run
  and the backup child inherits ownership via
  `TENVYR_MAINTENANCE_OWNED=1` (explicit re-entrancy, never a
  self-deadlock). E2E: concurrent backups -> exactly one PASS (its
  artifact drills PASS), the other fails fast; concurrent promotions ->
  only one enters authority mutation.
- MANIFEST CONTRACT FAILS CLOSED: `validateManifestContract` (shared in
  anchors.mjs) enforces the checksum TRIPLE (computed dump SHA-256 ==
  .sha256 sidecar == manifest.checksum; ANY mismatch fails), the
  verified-backup marker, version match, sha256 algorithm, full 40-hex
  sourceRevision, every REQUIRED structural anchor non-null and
  64-hex well-formed (optional execution/Capsule anchors stay nullable
  for empty databases), and the canonical 31-table inventory. All
  enforced pre-quiesce; corruption/tamper fail-closed within the
  single-owner trust boundary. Contract tests cover every class; E2E
  proves null-required-anchor and checksum-triple failures leave the
  deployment untouched.
- OPERATOR INSTRUCTIONS RE-AUDITED: `printUnrecoverableState` prints
  commands valid for the OBSERVED database state — it never instructs
  `safety -> active` while an active database exists without first
  preserving the active one under `tenvyr_failed_promotion`; the
  no-active-no-safety state prints a preserve-everything instruction with
  no automatic command. The D2 E2E executes the printed commands and
  repairs the deployment, then `--reconcile` proves the journal clears.
- Docs describe the ACTUAL crash-recovery and mutual-exclusion semantics
  (no "failure-safe state machine" overclaim). M8/M9/M10 remain
  independently accepted. M11 is NOT closed — closure remains the
  Technical Lead's decision.
