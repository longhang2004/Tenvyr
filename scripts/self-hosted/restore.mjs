#!/usr/bin/env node
/**
 * M11-S3: clean VERIFIED restore of the PostgreSQL authority.
 *
 * Two EXPLICIT modes — a drill never claims it restored authority, and
 * promotion is the only path that replaces the active database:
 *
 *   restore.mjs <backup.dump> --drill
 *     verify backup (checksum + manifest version)
 *     -> create isolated `tenvyr_restore` database
 *     -> restore
 *     -> deep integrity checks: recompute the backup SNAPSHOT anchors
 *        (migration ledger fingerprint, table inventory/count fingerprint,
 *        plan revision hash-ledger fingerprint, execution provenance
 *        anchor, terminal Capsule/export anchor) on the RESTORED database
 *        and compare against the BACKUP MANIFEST — the restore authority.
 *        Drift versus the CURRENT active database is informational
 *        evidence only and never invalidates a valid historical backup.
 *     -> PASS/FAIL
 *     -> the isolated database is left for inspection and dropped on the
 *        next run (bounded; the ACTIVE authority is never touched)
 *
 *   restore.mjs <backup.dump> --promote
 *     explicit recovery request with FAILURE-SAFE ordering:
 *     backup preflight (checksum + version + manifest shape)
 *     -> restore into `tenvyr_restore` + deep manifest-relative
 *        verification — ALL of this happens BEFORE any writer is
 *        quiesced, so every pre-swap failure leaves the original active
 *        database AND the previously healthy services untouched
 *     -> PASS
 *     -> quiesce authoritative writers (stop orchestrator + gateway; a
 *        partial quiesce failure restarts both services before failing)
 *     -> bounded authority swap via a deterministic state machine with
 *        automatic rollback: if `tenvyr -> tenvyr_pre_restore` succeeds
 *        but `tenvyr_restore -> tenvyr` fails, `tenvyr_pre_restore ->
 *        tenvyr` is attempted immediately; a rollback that itself fails
 *        preserves every database copy and prints the exact observed
 *        state plus bounded operator recovery commands (never success)
 *     -> restart services + readiness + invariants + Capsule/provenance
 *        reconstruction (where the backup has one) + post-recovery write
 *        proof — the pre-recovery safety copy (`tenvyr_pre_restore`) is
 *        KEPT until every gate passes (one bounded copy, replaced per
 *        recovery, never accumulated); any gate failure rolls back to the
 *        original authority (restored active -> bounded
 *        `tenvyr_failed_promotion`; safety -> active), restarts the
 *        original deployment, proves readiness + invariants, and returns
 *        failure — never PASS after a failed gate
 *
 * The renames are NOT transactionally atomic (PostgreSQL does not allow
 * ALTER DATABASE ... RENAME inside a transaction); the state machine
 * above is what makes the swap failure-safe.
 *
 * NON-CLAIMS (documented, never restored): local CLI authentication state,
 * external runtime sessions, provider secrets not owned by the database,
 * external artifact bytes, and external object stores.
 *
 * After restore the operator rotates deployment secrets and reconnects
 * runtimes explicitly (runtime auth is never restored).
 *
 * TEST HOOK (bounded, one-shot per label, never active by default):
 *   TENVYR_RESTORE_FAULT=second-rename|rollback-rename|post-gate-readiness|
 *   crash-after-first-rename|crash-after-promotion[,more]
 * Deterministically injects the named failure once, so the rollback paths
 * and the crash-recovery protocol are exercised by real fault-injection
 * tests. The crash labels terminate the process abruptly (SIGKILL) at the
 * named phase — no cleanup runs. Production behavior is unchanged when
 * the variable is unset.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareAnchors,
  REQUIRED_ANCHOR_KEYS,
  snapshotAnchors,
  validateManifestContract,
} from "./anchors.mjs";
import {
  ACTIVE_DB,
  acquireMaintenanceLock,
  clearJournal,
  FAILED_PROMOTION_DB,
  ISOLATED_DB,
  journalPath,
  planReconciliation,
  readJournal,
  releaseMaintenanceLock,
  SAFETY_DB,
  writeJournal,
} from "./maintenance.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const CONTAINER = "tenvyr-self-hosted-postgres";

/** Deploy env file: overridable so disposable-infrastructure tests never
 *  touch an operator's real deploy.env. */
const deployEnvPath = () =>
  process.env.TENVYR_DEPLOY_ENV ?? join(ROOT, "deploy.env");

const env = () => {
  const deploy = readFileSync(deployEnvPath(), "utf8");
  const values = {};
  for (const line of deploy.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    values[key.trim()] = rest.join("=").trim();
  }
  return values;
};

const psql = (args, { db = "postgres" } = {}) =>
  spawnSync(
    "docker",
    ["exec", CONTAINER, "psql", "-U", "tenvyr", "-d", db, "-tA", "-c", args],
    { encoding: "utf8", timeout: 60_000 },
  );

/** Anchor runner for a database name: (sql, db) -> { status, stdout }. */
const anchorRunner = (sql, db) => psql(sql, { db });

/** Bounded one-shot fault-injection hook (see header). */
const faults = new Set(
  (process.env.TENVYR_RESTORE_FAULT ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean),
);
const faulted = (label) => {
  if (faults.has(label)) {
    faults.delete(label);
    return true;
  }
  return false;
};

/** psql ALTER DATABASE rename wrapper: (from, to) -> { ok, error? }. */
const psqlRename = (from, to) => {
  const result = psql(`ALTER DATABASE ${from} RENAME TO ${to}`);
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: (result.stderr ?? "").trim() || `ALTER DATABASE ${from} RENAME TO ${to} failed` };
};

/**
 * M11 closure: deterministic authority-swap state machine (pure — rename
 * steps are injected so the contract test can exercise every phase).
 *
 *   drop-safety -> active-to-safety -> verified-to-active
 *
 * If the SECOND rename fails, `safety -> active` is attempted immediately.
 * A successful rollback returns phase "rolled-back" (the original
 * authority is active again); a failed rollback returns phase
 * "rollback-failed" with both errors — the caller must preserve every
 * database copy and print explicit recovery commands, never success.
 */
export const swapAuthority = (steps) => {
  const drop = steps.dropSafety();
  if (!drop.ok) return { ok: false, phase: "drop-safety", reason: drop.error };
  const first = steps.renameActiveToSafety();
  if (!first.ok) return { ok: false, phase: "active-to-safety", reason: first.error };
  const second = steps.renameVerifiedToActive();
  if (second.ok) return { ok: true, phase: "swapped" };
  const rollback = steps.renameSafetyToActive();
  if (rollback.ok) {
    return { ok: false, phase: "rolled-back", reason: second.error };
  }
  return {
    ok: false,
    phase: "rollback-failed",
    reason: second.error,
    rollbackError: rollback.error,
  };
};

/**
 * M11 closure: post-promotion rollback state machine (pure — rename steps
 * are injected). Moves the restored-but-unproven authority to the bounded
 * failed-promotion state and restores the original safety copy to active.
 */
export const rollbackPostPromotion = (steps) => {
  const first = steps.renameActiveToFailed();
  if (!first.ok) {
    return { ok: false, phase: "active-to-failed", reason: first.error };
  }
  const second = steps.renameSafetyToActive();
  if (!second.ok) {
    return { ok: false, phase: "safety-to-active", reason: second.error };
  }
  return { ok: true, phase: "rolled-back" };
};

/**
 * M11 closure: deep integrity checks against the BACKUP MANIFEST — the
 * restore authority. The restored snapshot's anchors must equal the
 * manifest's anchors (dump checksum is verified separately). The CURRENT
 * active database is NOT the authority: a legitimate advance of the live
 * database after the backup can never invalidate a valid historical
 * backup. Drift versus the current authority is returned as informational
 * evidence only. Returns the violation list (empty = PASS).
 */
export const deepIntegrityChecks = (manifest) => {
  if (!manifest?.anchors) {
    return [
      "backup manifest predates snapshot anchors — retake the backup with the current backup.mjs",
    ];
  }
  const restoredAnchors = snapshotAnchors(anchorRunner, ISOLATED_DB);
  return compareAnchors(manifest.anchors, restoredAnchors);
};

/**
 * Informational drift of the CURRENT active authority versus the backup
 * manifest (never a promotion requirement). Returns readable lines.
 */
export const driftVsCurrent = (manifest) => {
  if (!manifest?.anchors) return [];
  const lines = [];
  const currentAnchors = snapshotAnchors(anchorRunner, ACTIVE_DB);
  const keys = [
    "migrationLedgerFingerprint",
    "tableCountFingerprint",
    "planRevisionHashFingerprint",
    "executionAnchor",
  ];
  for (const key of keys) {
    if (currentAnchors[key] !== manifest.anchors[key]) {
      lines.push(
        `${key} differs from the backup snapshot (expected after legitimate post-backup writes; informational only)`,
      );
    }
  }
  const currentCapsule = currentAnchors.capsuleAnchor;
  const backupCapsule = manifest.anchors.capsuleAnchor;
  if (JSON.stringify(currentCapsule) !== JSON.stringify(backupCapsule)) {
    lines.push(
      "capsuleAnchor differs from the backup snapshot (expected after legitimate post-backup writes; informational only)",
    );
  }
  return lines;
};

/** Restores the dump into the isolated target database (drill/promote share). */
const restoreIntoIsolated = (dumpPath) => {
  const drop = psql(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`);
  if (drop.status !== 0) {
    throw new Error(`could not prepare target: ${drop.stderr}`);
  }
  const create = psql(`CREATE DATABASE ${ISOLATED_DB}`);
  if (create.status !== 0) {
    throw new Error(`could not create target: ${create.stderr}`);
  }
  const copy = spawnSync("docker", ["cp", dumpPath, `${CONTAINER}:/tmp/tenvyr-restore.dump`], { encoding: "utf8" });
  if (copy.status !== 0) {
    throw new Error(`docker cp: ${copy.stderr}`);
  }
  const restore = spawnSync(
    "docker",
    ["exec", CONTAINER, "pg_restore", "-U", "tenvyr", "-d", ISOLATED_DB, "--no-owner", "--no-privileges", "/tmp/tenvyr-restore.dump"],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (restore.status !== 0) {
    throw new Error(`pg_restore exited ${restore.status}: ${restore.stderr.slice(0, 2000)}`);
  }
};

/** Verify backup checksum + manifest CONTRACT. Returns the parsed
 *  manifest. The fail-closed contract (validateManifestContract) covers
 *  the checksum triple (dump SHA-256 == sidecar == manifest.checksum),
 *  version, algorithm, verified marker, source revision shape, required
 *  structural anchors (never null), and the canonical authority
 *  inventory. Every failure here happens BEFORE any quiescing. */
const verifyBackup = (dumpPath, TENVYR_VERSION) => {
  const bytes = readFileSync(dumpPath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const sidecar = `${dumpPath}.sha256`;
  // The manifest sidecar convention is "<dump>.manifest.json". For a path
  // that does NOT end in ".dump" (e.g. an arbitrary corrupted artifact),
  // the replace must not silently no-op onto the dump itself — append.
  let manifestPath = dumpPath.replace(/\.dump$/, ".manifest.json");
  if (manifestPath === dumpPath) manifestPath = `${dumpPath}.manifest.json`;
  let sidecarChecksum = null;
  if (existsSync(sidecar)) {
    sidecarChecksum = readFileSync(sidecar, "utf8").split(/\s+/)[0];
  }
  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(
        `malformed backup manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return validateManifestContract({
    manifest,
    dumpChecksum: checksum,
    sidecarChecksum,
    TENVYR_VERSION,
  });
};

const compose = () =>
  ["docker", "compose", "-f", "docker-compose.self-hosted.yml", "--env-file", deployEnvPath()];

/** Stops orchestrator + gateway (quiescing authoritative writers). A
 *  partial failure restarts BOTH services before reporting failure so a
 *  healthy deployment is never left half-stopped. */
const quiesce = () => {
  console.log("[restore] stopping orchestrator + gateway (quiescing authoritative writers)...");
  const stop = spawnSync("docker", [...compose().slice(1), "stop", "orchestrator", "gateway"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (stop.status !== 0) {
    const restart = spawnSync("docker", [...compose().slice(1), "start", "orchestrator", "gateway"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    const detail = restart.status === 0
      ? "services restarted"
      : `AND restarting the services ALSO failed: ${(restart.stderr ?? "").slice(0, 300)}`;
    throw new Error(`quiesce failed: ${(stop.stderr ?? "").slice(0, 500)} — ${detail}; the active authority was NOT touched`);
  }
  return true;
};

const startServices = () => {
  const start = spawnSync("docker", [...compose().slice(1), "start", "orchestrator", "gateway"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (start.status !== 0) {
    throw new Error(`could not restart services: ${(start.stderr ?? "").slice(0, 500)}`);
  }
  return true;
};

const orchestratorReady = (attempts = 20) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = spawnSync("curl", ["-s", "http://127.0.0.1:3001/health"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status === 0 && probe.stdout.includes('"ready":true')) return true;
    const sleepUntil = Date.now() + 500;
    while (Date.now() < sleepUntil) {
      // synchronous CLI sleep
    }
  }
  return false;
};

const gatewayReady = (attempts = 20) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = spawnSync("curl", ["-s", "http://127.0.0.1:3000/health"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (probe.status === 0 && probe.stdout.includes("UP")) return true;
    const sleepUntil = Date.now() + 500;
    while (Date.now() < sleepUntil) {
      // synchronous CLI sleep
    }
  }
  return false;
};

const runInvariants = () => {
  const result = spawnSync(process.execPath, ["scripts/self-hosted/invariants.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 120_000,
  });
  return result.status === 0;
};

/**
 * M11 closure: representative Capsule/provenance reconstruction gate.
 * When the backup manifest carries a terminal Capsule/export anchor, the
 * PROMOTED authority must reproduce it exactly (execution id + bounded
 * export pins). Not applicable when the backup had none.
 */
const capsuleReconstructionGate = (manifest) => {
  const expected = manifest?.anchors?.capsuleAnchor;
  if (!expected) return null;
  const actual = snapshotAnchors(anchorRunner, ACTIVE_DB).capsuleAnchor;
  const same =
    actual !== null &&
    actual.executionId === expected.executionId &&
    JSON.stringify(actual.exportIds) === JSON.stringify(expected.exportIds);
  return same
    ? null
    : `capsule/provenance reconstruction mismatch: manifest=${JSON.stringify(expected)} promoted=${JSON.stringify(actual)}`;
};

/** Post-recovery write proof: a NEW execution through the app API proves
 *  the running application writes to the restored authority. */
const writeProof = () => {
  const pipeline = spawnSync(
    "curl",
    ["-s", "-X", "POST", "http://127.0.0.1:3001/pipelines", "-H", "Content-Type: application/json", "-d", JSON.stringify({ name: `post-recovery-proof-${Date.now()}`, version: "1.0", steps: [{ id: "proof-step", agent: "proof-agent", input: {}, dependsOn: [] }] })],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  const pipelineBody = (() => {
    try {
      return JSON.parse(pipeline.stdout);
    } catch {
      return null;
    }
  })();
  const pipelineId = pipelineBody?.data?.id ?? pipelineBody?.id ?? null;
  if (!pipelineId) {
    return `post-recovery pipeline write did not persist: ${pipeline.stdout.slice(0, 300)}`;
  }
  const execution = spawnSync(
    "curl",
    ["-s", "-X", "POST", "http://127.0.0.1:3001/executions", "-H", "Content-Type: application/json", "-d", JSON.stringify({ pipelineId })],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  const executionBody = (() => {
    try {
      return JSON.parse(execution.stdout);
    } catch {
      return null;
    }
  })();
  const executionId = executionBody?.data?.id ?? executionBody?.id ?? null;
  if (!executionId) {
    return `post-recovery execution write did not persist: ${execution.stdout.slice(0, 300)}`;
  }
  console.log(`[restore] ok: promoted authority accepted a new execution (${executionId})`);
  return null;
};

/** Reads the observed database names inside the postgres container. */
const observedDatabases = () => {
  const result = psql("SELECT datname FROM pg_database ORDER BY datname");
  if (result.status !== 0) return null;
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/** Restart the original deployment and prove readiness + invariants.
 *  Returns { ok: true } or { ok: false, reason }. */
const restartAndProve = () => {
  try {
    startServices();
  } catch (error) {
    return { ok: false, reason: `service start failed: ${error.message}` };
  }
  if (!orchestratorReady() || !gatewayReady()) {
    return { ok: false, reason: "services did not become ready" };
  }
  if (!runInvariants()) {
    return { ok: false, reason: "invariants failed" };
  }
  return { ok: true };
};

/** Prints the exact observed database state and recovery instructions
 *  that are ACTUALLY VALID for that state. Never instructs
 *  safety -> active when an active database already exists without first
 *  accounting for it (the active one is preserved under the bounded
 *  failed-promotion name). Never success. */
const printUnrecoverableState = (context) => {
  console.error(`[restore] CRITICAL: ${context}`);
  const dbs = observedDatabases();
  const list = dbs === null ? "(could not read database list)" : dbs.join(", ");
  console.error(`[restore] observed database state: ${list}`);
  console.error("[restore] bounded operator recovery commands (valid for the observed state; run in order):");
  const hasActive = dbs?.includes(ACTIVE_DB) ?? false;
  const hasSafety = dbs?.includes(SAFETY_DB) ?? false;
  const psqlCmd = `docker exec ${CONTAINER} psql -U tenvyr -d postgres -c`;
  if (dbs === null) {
    console.error(`  ${psqlCmd} "SELECT datname FROM pg_database ORDER BY datname"   # inspect first`);
  } else if (hasSafety && !hasActive) {
    // The original authority is the safety copy; no active exists.
    console.error(`  ${psqlCmd} 'ALTER DATABASE ${SAFETY_DB} RENAME TO ${ACTIVE_DB}'`);
  } else if (hasSafety && hasActive) {
    // An active database already exists: it is the UNPROVEN restored
    // candidate — preserve it under the bounded failed name BEFORE
    // restoring the original, so no copy is lost.
    console.error(`  # the active database is the unproven restored candidate; preserve it first:`);
    console.error(`  ${psqlCmd} 'ALTER DATABASE ${ACTIVE_DB} RENAME TO ${FAILED_PROMOTION_DB}'`);
    console.error(`  ${psqlCmd} 'ALTER DATABASE ${SAFETY_DB} RENAME TO ${ACTIVE_DB}'`);
  } else if (!hasActive) {
    // No active authority AND no safety copy: no safe automatic command.
    console.error("  # NO active authority and NO safety copy exist — preserve every remaining");
    console.error("  # database copy; do NOT create a new tenvyr database; contact the");
    console.error("  # Technical Lead with the observed state above.");
  } else {
    // Active present, no safety: the original authority is active; nothing
    // to rename.
    console.error("  # the original authority is already active; no rename is needed.");
  }
  console.error(`  docker compose -f docker-compose.self-hosted.yml --env-file deploy.env start orchestrator gateway`);
  console.error(`  node scripts/self-hosted/restore.mjs --reconcile   # verify + clear the recovery journal`);
  console.error("[restore] every database copy is preserved; do NOT drop any database before the operator recovery is complete");
};

/**
 * Crash-recovery reconciliation: the durable journal + the OBSERVED
 * database names decide what the next recovery invocation must do —
 * BEFORE any destructive DROP/rename. The original authority is never
 * silently deleted: the safety copy is only ever renamed back (or
 * preserved with exact instructions). Returns an outcome object; when the
 * state was interrupted, the caller must abort the new operation (retry
 * required).
 */
const reconcileInterruptedState = () => {
  const journal = readJournal();
  const dbs = observedDatabases();
  if (dbs === null) {
    return {
      action: "blocked",
      message: "could not read the database state — refusing to start any maintenance operation",
    };
  }
  const plan = planReconciliation({
    phase: journal?.phase ?? null,
    databases: dbs,
  });
  if (plan.action === "proceed") {
    if (journal) clearJournal();
    return { action: "proceed" };
  }
  if (plan.action === "restore-original") {
    console.error(`[restore] detected an INTERRUPTED promotion (journal phase=${journal.phase}); the original authority is preserved as ${SAFETY_DB}`);
    const rename = psqlRename(SAFETY_DB, ACTIVE_DB);
    if (!rename.ok) {
      printUnrecoverableState(
        `reconciliation could not restore the original authority (${rename.error})`,
      );
      return { action: "blocked", message: "reconciliation failed — see CRITICAL state above" };
    }
    clearJournal();
    // The crashed promotion left the services quiesced: restart the
    // original deployment and prove readiness + invariants.
    const healthy = restartAndProve();
    if (!healthy.ok) {
      printUnrecoverableState(`reconciliation restored the original authority but the deployment is not healthy (${healthy.reason})`);
      return { action: "blocked", message: "reconciliation restored the original authority but the deployment is not healthy — see CRITICAL state above" };
    }
    console.error("[restore] reconciled: the original authority was RESTORED from the safety copy (renamed back, never dropped); services ready");
    return {
      action: "restore-original",
      message: "interrupted promotion reconciled — the original authority was restored from the safety copy; services are ready; the new operation was aborted; retry explicitly",
    };
  }
  if (plan.action === "rollback-candidate") {
    console.error(`[restore] detected an INTERRUPTED promotion (journal phase=${journal.phase}); the active database is the UNPROVEN restored candidate`);
    const preserve = psqlRename(ACTIVE_DB, FAILED_PROMOTION_DB);
    if (!preserve.ok) {
      printUnrecoverableState(
        `reconciliation could not preserve the unproven candidate (${preserve.error})`,
      );
      return { action: "blocked", message: "reconciliation failed — see CRITICAL state above" };
    }
    const rename = psqlRename(SAFETY_DB, ACTIVE_DB);
    if (!rename.ok) {
      printUnrecoverableState(
        `reconciliation could not restore the original authority (${rename.error})`,
      );
      return { action: "blocked", message: "reconciliation failed — see CRITICAL state above" };
    }
    clearJournal();
    const healthy = restartAndProve();
    if (!healthy.ok) {
      printUnrecoverableState(`reconciliation restored the original authority but the deployment is not healthy (${healthy.reason})`);
      return { action: "blocked", message: "reconciliation restored the original authority but the deployment is not healthy — see CRITICAL state above" };
    }
    console.error(`[restore] reconciled: the unproven candidate was preserved as ${FAILED_PROMOTION_DB}; the original authority restored; services ready`);
    return {
      action: "rollback-candidate",
      message: "interrupted promotion reconciled — the unproven candidate was preserved and the original authority restored; services are ready; the new operation was aborted; retry explicitly",
    };
  }
  // blocked: no safe automatic action — exact state + instructions.
  printUnrecoverableState(
    `no active authority AND no safety copy exist after an interrupted promotion (journal phase=${journal?.phase ?? "unknown"})`,
  );
  return { action: "blocked", message: "no safe automatic reconciliation exists — see CRITICAL state and instructions above" };
};

/** Post-promotion rollback: quiesce, move the unproven restored authority
 *  to the bounded failed state, restore the original safety copy to
 *  active, restart the original deployment, and prove readiness. */
const rollbackAfterGateFailure = (gateFailure) => {
  console.error(`[restore] FAIL: post-promotion gate failed: ${gateFailure}`);
  console.error("[restore] rolling back to the original authority (safety copy is still available)...");
  try {
    quiesce();
  } catch (error) {
    printUnrecoverableState(`post-promotion rollback could not quiesce writers: ${error.message}`);
    throw new Error("post-promotion gate failed and rollback could not quiesce writers — see CRITICAL state above");
  }
  const rollback = rollbackPostPromotion({
    renameActiveToFailed: () => psqlRename(ACTIVE_DB, FAILED_PROMOTION_DB),
    renameSafetyToActive: () =>
      faulted("rollback-rename") ? { ok: false, error: "injected fault: rollback-rename" } : psqlRename(SAFETY_DB, ACTIVE_DB),
  });
  if (!rollback.ok) {
    // The journal is KEPT: the next invocation reconciles this state.
    printUnrecoverableState(
      `post-promotion rollback failed at "${rollback.phase}": ${rollback.reason}`,
    );
    throw new Error("post-promotion gate failed AND rollback failed — see CRITICAL state and recovery instructions above");
  }
  // The state is reconciled (original authority active again): clear the
  // durable journal. Bounded cleanup: the failed candidate is dropped only
  // AFTER the original authority is active again.
  clearJournal();
  psql(`DROP DATABASE IF EXISTS ${FAILED_PROMOTION_DB}`);
  startServices();
  if (!orchestratorReady() || !gatewayReady()) {
    printUnrecoverableState("post-rollback services did not become ready");
    throw new Error("post-promotion rollback restored the database but services did not become ready — see CRITICAL state above");
  }
  if (!runInvariants()) {
    printUnrecoverableState("post-rollback invariants failed");
    throw new Error("post-promotion rollback restored the database but invariants failed — see CRITICAL state above");
  }
  throw new Error(
    `post-promotion gate failed (${gateFailure}) — automatic rollback restored the original authority; services are ready and invariants pass`,
  );
};

/** All post-swap gates, in the required order. Returns null on pass or a
 *  bounded failure reason. */
const runPostPromotionGates = (manifest) => {
  try {
    startServices();
  } catch (error) {
    return `service start failed: ${error.message}`;
  }
  if (faulted("post-gate-readiness") || !orchestratorReady()) {
    return "orchestrator not ready after promotion";
  }
  if (!gatewayReady()) {
    return "gateway not ready after promotion";
  }
  if (!runInvariants()) {
    return "post-promotion invariants failed";
  }
  const capsuleFailure = capsuleReconstructionGate(manifest);
  if (capsuleFailure) {
    return capsuleFailure;
  }
  const writeFailure = writeProof();
  if (writeFailure) {
    return writeFailure;
  }
  return null;
};

/** `--reconcile` mode: inspect + reconcile the recovery state only. */
const reconcileMode = () => {
  const lock = acquireMaintenanceLock();
  if (!lock.owned) {
    console.error("[restore] FAIL: maintenance operation already active — refusing to interleave");
    process.exit(1);
  }
  try {
    const outcome = reconcileInterruptedState();
    if (outcome.action === "blocked") {
      process.exitCode = 1;
    } else if (outcome.action === "proceed") {
      console.log("[restore] reconcile: no interrupted promotion detected — the recovery journal is clear");
    } else {
      console.log(`[restore] reconcile: ${outcome.message}`);
    }
  } catch (error) {
    console.error(`[restore] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    releaseMaintenanceLock(lock);
  }
};

const main = () => {
  if (process.argv[2] === "--reconcile") {
    reconcileMode();
    return;
  }
  const backupArg = process.argv[2];
  const modeArg = process.argv[3] ?? "--drill";
  if (!backupArg) {
    console.error("[restore] usage: restore.mjs <backup.dump> [--drill|--promote] | restore.mjs --reconcile");
    process.exit(1);
  }
  if (modeArg !== "--drill" && modeArg !== "--promote") {
    console.error(`[restore] FAIL: unknown mode "${modeArg}"; use --drill (verify only) or --promote (recovery)`);
    process.exit(1);
  }
  const dumpPath = backupArg.startsWith("/") ? backupArg : join(ROOT, backupArg);
  if (!existsSync(dumpPath)) {
    console.error(`[restore] FAIL: backup file not found: ${dumpPath}`);
    process.exit(1);
  }
  const { TENVYR_VERSION, POSTGRES_PASSWORD } = env();
  if (!TENVYR_VERSION || !POSTGRES_PASSWORD) {
    console.error("[restore] FAIL: deploy.env must set TENVYR_VERSION and POSTGRES_PASSWORD");
    process.exit(1);
  }

  // Maintenance serialization: only one backup/restore operation may use
  // the shared bounded resources at a time (a crashed owner releases the
  // lock automatically via dead-PID stale reclaim).
  const lock = acquireMaintenanceLock();
  if (!lock.owned) {
    const owner = lock.owner
      ? ` (owner pid ${lock.owner.pid} since ${lock.owner.startedAt})`
      : "";
    console.error(
      `[restore] FAIL: maintenance operation already active${owner} — refusing to interleave; wait for it to finish or clear the stale lock at backups/.maintenance.lock`,
    );
    process.exit(1);
  }

  try {
    // 0. Crash-recovery reconciliation BEFORE any destructive DROP/rename.
    //    A process death at ANY promotion phase leaves the durable
    //    journal + the database names; this invocation reconciles the
    //    observed state first. The original authority is never silently
    //    deleted (the safety copy is only ever renamed back).
    const outcome = reconcileInterruptedState();
    if (outcome.action !== "proceed") {
      // The interrupted state was reconciled; the NEW operation must not
      // proceed — an explicit retry is required.
      throw new Error(outcome.message);
    }
    // Bounded cleanup of a preserved failed-candidate from an earlier
    // reconciled interruption (never an original authority).
    psql(`DROP DATABASE IF EXISTS ${FAILED_PROMOTION_DB}`);

    // 1. Preflight (checksum + manifest CONTRACT). Any failure here
    //    leaves the active authority AND the services untouched.
    const manifest = verifyBackup(dumpPath, TENVYR_VERSION);
    console.log(`[restore] ok: backup version ${manifest.version} matches deployment; verified backup contract PASS`);

    if (modeArg === "--drill") {
      console.log("[restore] DRILL mode: the ACTIVE authority is never touched.");
      restoreIntoIsolated(dumpPath);
      const violations = deepIntegrityChecks(manifest);
      for (const line of driftVsCurrent(manifest)) {
        console.log(`[restore] info: ${line}`);
      }
      if (violations.length > 0) {
        throw new Error(`DRILL integrity violations:\n  ${violations.join("\n  ")}`);
      }
      console.log(`[restore] DRILL PASS ${dumpPath}`);
      console.log(`[restore] isolated database "${ISOLATED_DB}" left for inspection; it is NOT the active authority`);
      console.log("[restore] to make this backup the active authority, re-run with --promote");
      return;
    }

    // ---- --promote: explicit recovery ----
    console.log("[restore] PROMOTE mode: this REPLACES the active authority after verification.");
    // 2. Restore into the isolated database + deep manifest-relative
    //    verification — ALL BEFORE any writer is quiesced.
    console.log("[restore] restoring backup into the isolated verification database...");
    restoreIntoIsolated(dumpPath);
    const violations = deepIntegrityChecks(manifest);
    for (const line of driftVsCurrent(manifest)) {
      console.log(`[restore] info: ${line}`);
    }
    if (violations.length > 0) {
      throw new Error(`restored database failed deep integrity checks; the ACTIVE authority was NOT replaced:\n  ${violations.join("\n  ")}`);
    }
    console.log("[restore] verified backup (pre-quiesce): checksum + manifest contract + deep integrity PASS against the backup manifest");
    writeJournal("verify-done", dumpPath);

    // 3. Quiesce writers (partial failure restarts both services).
    quiesce();
    writeJournal("quiescing", dumpPath);

    // 4. Bounded authority swap with deterministic automatic rollback.
    //    The durable journal advances BEFORE each destructive rename, so
    //    a crash at any point is reconciled by the next invocation.
    console.log("[restore] promoting the verified database to ACTIVE authority...");
    writeJournal("swap-active-to-safety", dumpPath);
    const swap = swapAuthority({
      dropSafety: () => {
        const drop = psql(`DROP DATABASE IF EXISTS ${SAFETY_DB}`);
        return drop.status === 0 ? { ok: true } : { ok: false, error: (drop.stderr ?? "").trim() || "could not replace the previous safety copy" };
      },
      renameActiveToSafety: () => {
        const result = psqlRename(ACTIVE_DB, SAFETY_DB);
        if (result.ok) {
          writeJournal("swap-verified-to-active", dumpPath);
          if (faulted("crash-after-first-rename")) {
            process.kill(process.pid, "SIGKILL");
          }
        }
        return result;
      },
      renameVerifiedToActive: () => {
        const result = faulted("second-rename")
          ? { ok: false, error: "injected fault: second-rename" }
          : psqlRename(ISOLATED_DB, ACTIVE_DB);
        if (result.ok) {
          writeJournal("post-gates", dumpPath);
          if (faulted("crash-after-promotion")) {
            process.kill(process.pid, "SIGKILL");
          }
        }
        return result;
      },
      renameSafetyToActive: () =>
        faulted("rollback-rename") ? { ok: false, error: "injected fault: rollback-rename" } : psqlRename(SAFETY_DB, ACTIVE_DB),
    });
    if (!swap.ok) {
      if (swap.phase === "rollback-failed") {
        // The journal is KEPT: the next invocation reconciles this state
        // (safety holds the original authority).
        printUnrecoverableState(
          `promotion swap failed (${swap.reason}) AND automatic rollback failed (${swap.rollbackError})`,
        );
        throw new Error("promotion swap failed and rollback failed — the original authority is preserved as tenvyr_pre_restore; see CRITICAL state and recovery instructions above");
      }
      if (swap.phase === "rolled-back") {
        // Original authority is active again (the state is reconciled):
        // clear the journal, restart + prove readiness, then return
        // promotion failure (never success).
        clearJournal();
        startServices();
        if (!orchestratorReady() || !gatewayReady()) {
          printUnrecoverableState("post-rollback services did not become ready");
          throw new Error("promotion swap failed, rollback restored the original authority, but services did not become ready — see CRITICAL state above");
        }
        if (!runInvariants()) {
          printUnrecoverableState("post-rollback invariants failed");
          throw new Error("promotion swap failed, rollback restored the original authority, but invariants failed — see CRITICAL state above");
        }
        console.log(`[restore] ok: original authority restored after failed swap (${swap.reason})`);
        throw new Error("promotion swap failed — automatic rollback restored the original authority; services are ready and invariants pass");
      }
      // drop-safety / active-to-safety: the active authority was NEVER
      // renamed; restart the quiesced services and fail.
      clearJournal();
      startServices();
      console.log(`[restore] ok: services restarted; active authority untouched (swap failed at "${swap.phase}")`);
      throw new Error(`promotion swap failed at "${swap.phase}": ${swap.reason} — the active authority was NOT touched`);
    }
    console.log(`[restore] ok: verified database promoted to "${ACTIVE_DB}"; pre-recovery authority kept as "${SAFETY_DB}"`);

    // 5. Post-promotion gates: service start, readiness, invariants,
    //    Capsule/provenance reconstruction, post-recovery write. The
    //    safety copy is KEPT until every gate passes; any gate failure
    //    triggers automatic rollback to the original authority.
    const gateFailure = runPostPromotionGates(manifest);
    if (gateFailure !== null) {
      rollbackAfterGateFailure(gateFailure);
      // rollbackAfterGateFailure always throws; this line is unreachable.
      process.exit(1);
    }
    // Durable completion marker: distinguishes a fully completed recovery
    // (safety copy retained as a completed artifact) from an interrupted
    // one. Written BEFORE printing PASS.
    writeJournal("complete", dumpPath);
    console.log("[restore] PASS: verified backup promoted; readiness, invariants, Capsule/provenance reconstruction, and a new write all proven");
    console.log("[restore] next: rotate deployment secrets, reconnect runtimes (runtime auth is never restored).");
    console.log("[restore] NOT restored: local CLI auth state, external runtime sessions, provider secrets, artifact bytes, object stores.");
  } catch (error) {
    console.error(`[restore] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    releaseMaintenanceLock(lock);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
