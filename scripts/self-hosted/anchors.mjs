#!/usr/bin/env node
/**
 * M11 closure: snapshot anchors shared by backup and restore.
 *
 * The restore authority is the BACKUP MANIFEST, never the current active
 * database: backup captures bounded integrity metadata about the backup
 * snapshot itself (dump checksum, release/source identity, migration
 * ledger fingerprint, table inventory/count fingerprint, plan revision
 * hash-ledger fingerprint, execution provenance anchor, and a
 * representative terminal Capsule/export anchor). The anchors are computed
 * FROM THE RESTORED DUMP inside an isolated verification database — never
 * from the live database — so a manifest that exists is by construction
 * consistent with the dump artifact it describes. Restore recomputes the
 * same anchors on the restored snapshot and compares against the
 * manifest — a legitimate advance of the live database after the backup
 * can never invalidate a valid historical backup.
 *
 * The inventory is the authoritative Tenvyr application authority table
 * set: it MUST match the repository's entity/schema inventory exactly
 * (regression-tested against `services/orchestrator/src/entities` and the
 * migrations). PostgreSQL system/framework tables (e.g. `migrations`),
 * external Artifact URI bytes, runtime-local auth, and provider sessions
 * are NOT Tenvyr-owned database backup coverage.
 */
import { createHash } from "node:crypto";

/** The backup data inventory (PostgreSQL authority only). */
export const TABLES = [
  "pipelines",
  "executions",
  "execution_plan_revisions",
  "plan_proposals",
  "step_executions",
  "step_attempts",
  "dispatch_outbox",
  "result_inbox",
  "result_conflicts",
  "agent_events",
  "agent_event_conflicts",
  "policy_snapshots",
  "policy_decisions",
  "budget_accounts",
  "budget_reservations",
  "budget_ledger_entries",
  "approval_requests",
  "artifacts",
  "artifact_exposures",
  "state_write_evidence",
  "execution_replays",
  "execution_exports",
  "delegation_requests",
  "delegation_observations",
  "delegation_request_conflicts",
  "delegation_observation_conflicts",
  "runtime_connections",
  "connection_revisions",
  "coordination_runs",
  "coordination_iterations",
  "operator_actions",
];

export const fingerprint = (value) =>
  createHash("sha256").update(value ?? "").digest("hex");

/** Migration ledger: the ordered migration NAME sequence. An empty ledger
 *  fingerprints deterministically as the empty string (valid snapshot). */
export const migrationLedgerSql = () =>
  `SELECT COALESCE(string_agg(name, '|' ORDER BY name), '') AS value FROM migrations`;

/** One query returning every inventory table's row count in TABLES order. */
export const tableCountsSql = (tables = TABLES) =>
  `SELECT ${tables
    .map((table) => `(SELECT count(*) FROM ${table}) AS "${table}"`)
    .join(", ")}`;

/** Plan revision hash ledger: every revision's immutable plan hash. An
 *  empty ledger (no executions yet) fingerprints deterministically as the
 *  empty string — a valid snapshot, never a failure. */
export const planHashLedgerSql = () =>
  `SELECT COALESCE(string_agg("planHash", '|' ORDER BY "executionId", "revisionNumber"), '') AS value FROM execution_plan_revisions`;

/** Execution provenance anchor: the earliest execution (creation order). */
export const executionAnchorSql = () =>
  `SELECT id AS value FROM executions ORDER BY "createdAt" LIMIT 1`;

/** Representative terminal execution (most recently updated terminal). */
export const capsuleExecutionSql = () =>
  `SELECT id AS value FROM executions WHERE status IN ('COMPLETED','FAILED','CANCELLED') ORDER BY "updatedAt" DESC LIMIT 1`;

/** Bounded Capsule/export pins of one execution (ids + capsule hashes). */
export const capsuleExportSql = (executionId) =>
  `SELECT string_agg(id || ':' || "capsuleHash", '|' ORDER BY id) AS value FROM execution_exports WHERE "executionId" = '${executionId}'`;

/** Runner contract: (sql) -> { status: number, stdout: string }. */
export const parseSingle = (result) =>
  result.status === 0 ? (result.stdout ?? "").trim() : null;

/**
 * Computes the bounded snapshot anchors of a database through `run`
 * ((sql, db) -> { status, stdout }). A null field means the anchor could
 * not be captured — backup fails closed on that, restore treats it as a
 * manifest defect.
 */
export const snapshotAnchors = (run, db, tables = TABLES) => {
  const ledger = parseSingle(run(migrationLedgerSql(), db));
  const countsLine = parseSingle(run(tableCountsSql(tables), db));
  const planHashes = parseSingle(run(planHashLedgerSql(), db));
  const executionAnchor = parseSingle(run(executionAnchorSql(), db)) || null;
  const terminalExecution =
    parseSingle(run(capsuleExecutionSql(), db)) || null;
  const exportsLine = terminalExecution
    ? parseSingle(run(capsuleExportSql(terminalExecution), db))
    : null;
  const counts = countsLine ? countsLine.split("|") : [];
  const countsComplete =
    counts.length === tables.length && counts.every((c) => c !== "");
  const capsuleAnchor =
    terminalExecution === null
      ? null
      : {
          executionId: terminalExecution,
          exportIds: exportsLine ? exportsLine.split("|") : [],
        };
  return {
    migrationLedgerFingerprint:
      ledger === null ? null : fingerprint(ledger),
    tableCountFingerprint: countsComplete
      ? fingerprint(tables.map((table, i) => `${table}:${counts[i]}`).join(","))
      : null,
    planRevisionHashFingerprint:
      planHashes === null ? null : fingerprint(planHashes),
    executionAnchor,
    capsuleAnchor,
  };
};

/**
 * Compares the restored snapshot's anchors against the BACKUP MANIFEST's
 * anchors (the authority). Returns the violation list (empty = PASS).
 * Fields the manifest did not capture are skipped (an old manifest
 * without anchors is a separate, explicit violation — fail closed).
 */
export const compareAnchors = (expected, actual) => {
  const violations = [];
  if (
    !expected ||
    typeof expected !== "object" ||
    expected.migrationLedgerFingerprint === undefined
  ) {
    return [
      "backup manifest predates snapshot anchors — retake the backup with the current backup.mjs",
    ];
  }
  for (const key of [
    "migrationLedgerFingerprint",
    "tableCountFingerprint",
    "planRevisionHashFingerprint",
    "executionAnchor",
  ]) {
    if (expected[key] === null || expected[key] === undefined) continue;
    if (actual[key] !== expected[key]) {
      violations.push(
        `${key} mismatch: backup manifest=${expected[key]} restored=${actual[key]}`,
      );
    }
  }
  if (expected.capsuleAnchor !== null && expected.capsuleAnchor !== undefined) {
    const actualAnchor = actual.capsuleAnchor ?? null;
    const same =
      actualAnchor !== null &&
      actualAnchor.executionId === expected.capsuleAnchor.executionId &&
      JSON.stringify(actualAnchor.exportIds) ===
        JSON.stringify(expected.capsuleAnchor.exportIds);
    if (!same) {
      violations.push(
        `capsuleAnchor mismatch: backup manifest=${JSON.stringify(
          expected.capsuleAnchor,
        )} restored=${JSON.stringify(actualAnchor)}`,
      );
    }
  }
  return violations;
};
