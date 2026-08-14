#!/usr/bin/env node
/**
 * M11-S3: VERIFIED backup of the PostgreSQL authority.
 *
 * Invariant: if `self-hosted:backup` reports PASS, the manifest is ALREADY
 * proven to describe a restorable dump artifact — a later drill is never
 * the first verification.
 *
 * Flow (dump-derived verification — anchors NEVER come from the live
 * database):
 *
 *   consistent pg_dump of the active authority
 *     -> restore the dump into an isolated verification database
 *        (`tenvyr_backup_verify`, bounded, dropped before and after)
 *     -> compute ALL manifest anchors FROM THE RESTORED DUMP
 *     -> prove the restored snapshot is structurally valid
 *        (migration ledger + full 31-table inventory counts + plan hash
 *         ledger all readable)
 *     -> only then finalize the verified manifest + checksum, rename the
 *        staging dump to its final name, and print PASS
 *
 * Any failure (dump, restore, anchor computation, structural validation)
 * removes the staging artifact, drops the verification database, and
 * reports FAIL — a failed verification is never labeled a verified
 * successful backup. The ACTIVE authority is only ever read (pg_dump
 * snapshot); concurrent writes during backup can never make the verified
 * artifact inconsistent, because the manifest describes the dump itself.
 *
 * External artifact bytes and runtime auth are NEVER captured.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  snapshotAnchors,
  TABLES,
} from "./anchors.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const BACKUP_DIR = join(ROOT, "backups");
/** Bounded isolated verification database (never the active authority). */
export const VERIFY_DB = "tenvyr_backup_verify";

const container = () => "tenvyr-self-hosted-postgres";

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

const docker = (args, opts = {}) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, ...opts });

/** psql runner against a database inside the postgres container. */
const psqlFor = (db) => (sql) =>
  docker(["exec", container(), "psql", "-U", "tenvyr", "-d", db, "-tA", "-c", sql]);

/** Pure manifest assembly (exported so the contract test can prove the
 *  backup records release AND source identity, the snapshot anchors, and
 *  the verified-backup marker). */
export const buildManifest = (base, anchors, sourceRevision) => ({
  ...base,
  sourceRevision,
  verified: true,
  verification: "dump-derived: anchors computed from an isolated restore of this exact dump",
  anchors,
});

/** The three structural fingerprints that must be computable from the
 *  restored dump (null means the restored snapshot is not structurally
 *  valid — the backup must fail, never PASS). */
export const REQUIRED_ANCHOR_KEYS = [
  "migrationLedgerFingerprint",
  "tableCountFingerprint",
  "planRevisionHashFingerprint",
];

const main = () => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const { TENVYR_VERSION, POSTGRES_PASSWORD, TENVYR_SOURCE_REVISION } = env();
  if (!TENVYR_VERSION || !POSTGRES_PASSWORD) {
    console.error("[backup] FAIL: deploy.env must set TENVYR_VERSION and POSTGRES_PASSWORD");
    process.exit(1);
  }
  // M11 closure: the deployment identity model has ONE meaning per key —
  // TENVYR_VERSION is the release version (vMAJOR.MINOR.PATCH) and
  // TENVYR_SOURCE_REVISION is the immutable git commit SHA the deployed
  // images were built from. A backup without source provenance cannot
  // attest what it is, so it fails closed:
  //   TENVYR_SOURCE_REVISION=$(git rev-parse HEAD)
  if (!/^[0-9a-f]{40}$/.test(TENVYR_SOURCE_REVISION ?? "")) {
    console.error(
      "[backup] FAIL: deploy.env must set TENVYR_SOURCE_REVISION to the full git commit SHA of the deployed source (e.g. TENVYR_SOURCE_REVISION=$(git rev-parse HEAD))",
    );
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `tenvyr-${TENVYR_VERSION}-${timestamp}`;
  const stagingPath = join(BACKUP_DIR, `.staging-${base}.dump`);
  const finalPath = join(BACKUP_DIR, `${base}.dump`);
  let finalized = false;
  // Failure contract: any step failure throws, the catch reports FAIL (the
  // artifact is never labeled verified), and the finally block always
  // performs deterministic cleanup (verification DB, in-container staging,
  // and the host staging artifact while it is not a finalized backup).
  try {
    // 1. Consistent snapshot of the ACTIVE authority (read-only).
    const dump = docker([
      "exec",
      container(),
      "pg_dump",
      "-U",
      "tenvyr",
      "-d",
      "tenvyr",
      "-Fc",
      "-f",
      "/tmp/tenvyr-backup.dump",
    ]);
    if (dump.status !== 0) {
      throw new Error(`pg_dump exited ${dump.status}: ${dump.stderr}`);
    }
    const copy = docker(["cp", `${container()}:/tmp/tenvyr-backup.dump`, stagingPath]);
    if (copy.status !== 0) {
      throw new Error(`docker cp exited ${copy.status}: ${copy.stderr}`);
    }

    // 2. Restore the dump into the isolated verification database.
    const dropVerify = psqlFor("postgres")(`DROP DATABASE IF EXISTS ${VERIFY_DB}`);
    if (dropVerify.status !== 0) {
      throw new Error(`could not prepare verification database: ${dropVerify.stderr}`);
    }
    const createVerify = psqlFor("postgres")(`CREATE DATABASE ${VERIFY_DB}`);
    if (createVerify.status !== 0) {
      throw new Error(`could not create verification database: ${createVerify.stderr}`);
    }
    const stageInContainer = docker(["cp", stagingPath, `${container()}:/tmp/tenvyr-backup-verify.dump`]);
    if (stageInContainer.status !== 0) {
      throw new Error(`docker cp (verify stage) exited ${stageInContainer.status}: ${stageInContainer.stderr}`);
    }
    const restore = docker([
      "exec",
      container(),
      "pg_restore",
      "-U",
      "tenvyr",
      "-d",
      VERIFY_DB,
      "--no-owner",
      "--no-privileges",
      "/tmp/tenvyr-backup-verify.dump",
    ]);
    if (restore.status !== 0) {
      throw new Error(`pg_restore into verification database exited ${restore.status}: ${restore.stderr.slice(0, 2000)}`);
    }

    // 3. Compute ALL manifest anchors FROM THE RESTORED DUMP — never from
    //    the live database — and prove structural validity.
    const anchors = snapshotAnchors(psqlFor(VERIFY_DB), VERIFY_DB);
    for (const key of REQUIRED_ANCHOR_KEYS) {
      if (anchors[key] === null) {
        throw new Error(
          `restored dump is not structurally valid — could not capture snapshot anchor "${key}" (schema/inventory mismatch or corrupt dump)`,
        );
      }
    }

    // 4. Checksum + finalize the verified artifact.
    const bytes = readFileSync(stagingPath);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    renameSync(stagingPath, finalPath);
    finalized = true;
    writeFileSync(`${finalPath}.sha256`, `${checksum}  ${base}.dump\n`);
    const manifest = buildManifest(
      {
        version: TENVYR_VERSION,
        timestamp: new Date().toISOString(),
        file: `${base}.dump`,
        checksum,
        algorithm: "sha256",
        scope: "PostgreSQL authority only (no artifact bytes, no runtime auth)",
        tables: TABLES.join(", "),
      },
      anchors,
      TENVYR_SOURCE_REVISION,
    );
    writeFileSync(join(BACKUP_DIR, `${base}.manifest.json`), JSON.stringify(manifest, null, 2));
    console.log(`[backup] PASS ${finalPath}`);
    console.log(`[backup] sha256 ${checksum}`);
    console.log(`[backup] manifest: version=${manifest.version} sourceRevision=${manifest.sourceRevision} verified=${manifest.verified}`);
  } catch (error) {
    console.error(`[backup] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    // Deterministic cleanup: the verification database and in-container
    // staging files are always removed; a failed verification also removes
    // the host staging artifact so it can never be mistaken for a backup.
    psqlFor("postgres")(`DROP DATABASE IF EXISTS ${VERIFY_DB}`);
    docker(["exec", container(), "rm", "-f", "/tmp/tenvyr-backup.dump", "/tmp/tenvyr-backup-verify.dump"], { timeout: 30_000 });
    if (!finalized) {
      try {
        rmSync(stagingPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
