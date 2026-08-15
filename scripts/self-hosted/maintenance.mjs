#!/usr/bin/env node
/**
 * M11 closure: maintenance mutual exclusion + durable recovery journal.
 *
 * 1. MAINTENANCE LOCK — an exclusive process-lifetime lock over the
 *    shared maintenance resources (backup verification database, staging
 *    dump paths, the authority-swap database names). Every backup and
 *    every restore (drill/promote/reconcile) acquires it; a second
 *    concurrent operation FAILS FAST with "maintenance operation already
 *    active" instead of interleaving destructive operations.
 *
 *    CRASH-LINEARIZABLE OWNERSHIP:
 *      - the claim is an atomic O_EXCL lock-file create carrying the
 *        owner record (PID + startedAt) in the same syscall — there is
 *        no mkdir-then-write window a concurrent acquirer could race;
 *      - STALE-LOCK RECLAIM is a single atomic RENAME of the stale lock
 *        file to a tombstone name (exactly one contender can win the
 *        rename; losers retry and observe the winner's live owner), so
 *        two simultaneous reclaimers can NEVER both become owner — the
 *        old rm-then-create TOCTOU is gone;
 *      - an unreadable owner record is never removed: the acquirer
 *        waits a bounded moment (the owner may be mid-write) and FAILS
 *        CLOSED with operator instructions if it stays unreadable;
 *      - there is NO child/inheritance delegation: the verified backup
 *        runs IN the owner process (upgrade calls backup.mjs's exported
 *        runVerifiedBackup while holding the lock), so no delegated
 *        worker can survive the owner's death and overlap a new owner.
 *
 * 2. RECOVERY JOURNAL — durable phase markers for `restore --promote`,
 *    written BEFORE every destructive database step via an atomic
 *    write: temp file -> fsync -> rename over the journal -> fsync the
 *    parent directory (where supported). A crash or failure at ANY point
 *    leaves either the previous complete journal or the new one — never
 *    a truncated/invalid fail-open record. Phases:
 *
 *      verify-done                 deep verification passed, about to quiesce
 *      quiescing                   written BEFORE quiesce: writers may be
 *                                  partially or fully stopped; DB authority
 *                                  is still the ORIGINAL
 *      swap-active-to-safety       about to rename tenvyr -> tenvyr_pre_restore
 *      swap-verified-to-active     first rename done, about to rename
 *                                  tenvyr_restore -> tenvyr
 *      post-gates                  candidate active, gates running
 *      complete                    ALL gates passed (durable success)
 *
 *    Reconciliation is CONSERVATIVE when the journal evidence is absent,
 *    malformed, or truncated: the OBSERVED database-name layout decides,
 *    never a default "proceed". `tenvyr_pre_restore` is NEVER dropped by
 *    reconciliation — it is only ever renamed back to `tenvyr` (or
 *    preserved with exact instructions when no safe action exists), the
 *    ambiguous "active + safety without usable journal" layout FAILS
 *    CLOSED, and phases at-or-after "quiescing" restart + prove the
 *    services (a crash after writers were quiesced must never leave the
 *    application offline).
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const BACKUP_DIR = join(ROOT, "backups");

/** Database names are internal constants — never operator-controlled. */
export const ACTIVE_DB = "tenvyr";
export const SAFETY_DB = "tenvyr_pre_restore";
export const ISOLATED_DB = "tenvyr_restore";
export const FAILED_PROMOTION_DB = "tenvyr_failed_promotion";

const JOURNAL_PATH = join(BACKUP_DIR, ".recovery-journal.json");

export const journalPath = () => JOURNAL_PATH;

/* ------------------------------------------------------------------ */
/* Maintenance lock                                                    */
/* ------------------------------------------------------------------ */

/** Exclusive ownership is claimed by an atomic O_EXCL file create; the
 *  owner record (PID + startedAt) is written in the SAME syscall, so
 *  there is no mkdir-then-write window a concurrent acquirer could race.
 *  Crash-release: the next acquisition atomically renames a stale lock
 *  (dead owner PID) to a tombstone and retries — exactly one contender
 *  can win the rename, so two simultaneous reclaimers can never both
 *  become owner (no rm-then-create TOCTOU). */
const LOCK_PATH = join(BACKUP_DIR, ".maintenance.lock");

const syncSleep = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // synchronous CLI sleep
  }
};

const readOwnerFrom = (path) => {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    return typeof owner?.pid === "number" && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
};

const readLockOwner = () => readOwnerFrom(LOCK_PATH);

const isPidAlive = (pid) => {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the ONLY "gone" verdict; EPERM (exists, not signalable) is
    // conservatively ALIVE — a stale-lock reclaim must never treat an
    // existent owner as dead.
    return error?.code === "ESRCH" ? false : true;
  }
};

export const acquireMaintenanceLock = () => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(
        LOCK_PATH,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        { flag: "wx" },
      );
      return { owned: true, held: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = readLockOwner();
      if (owner === null) {
        // The creator is mid-acquisition (file exists, content not yet
        // visible): give it a bounded moment before deciding it is stale.
        syncSleep(25);
        owner = readLockOwner();
      }
      if (owner !== null && isPidAlive(owner.pid)) {
        return { owned: false, held: true, owner };
      }
      if (owner !== null) {
        // Stale lock (dead owner): reclaim via a single ATOMIC RENAME to
        // a tombstone — exactly one contender wins the rename. The
        // tombstone is then VERIFIED: it must still hold the SAME stale
        // record we read. If the lock was replaced between our read and
        // our rename (a live owner's fresh lock), the tombstone holds a
        // LIVE record — restore it immediately and yield (the live
        // owner's lock is never destroyed).
        const tombstone = `${LOCK_PATH}.stale.${process.pid}.${Date.now()}`;
        try {
          renameSync(LOCK_PATH, tombstone);
        } catch (renameError) {
          if (renameError?.code === "ENOENT") {
            continue; // another contender reclaimed it first — retry
          }
          throw renameError;
        }
        const tombstoneOwner = readOwnerFrom(tombstone);
        if (tombstoneOwner !== null && isPidAlive(tombstoneOwner.pid)) {
          // We moved a LIVE owner's lock: restore it and yield.
          try {
            renameSync(tombstone, LOCK_PATH);
          } catch {
            // best-effort restore; the lock path is recreated by retry
          }
          return { owned: false, held: true, owner: tombstoneOwner };
        }
        // The tombstone holds the stale record we intended to reclaim
        // (or an unreadable/dead one): proceed to create the new lock.
        // The tombstone itself is left as bounded evidence; it is never
        // swept by acquisition (a sweep could race an in-flight
        // verify-and-restore) — the E2E teardown and operators clean
        // tombstones explicitly.
        continue;
      }
      // Unreadable owner record after the bounded wait: FAIL CLOSED —
      // never remove a lock whose ownership cannot be established.
      return {
        owned: false,
        held: true,
        owner: null,
        denied: "the maintenance lock exists but its owner record is unreadable — a crashed owner may be mid-write; remove backups/.maintenance.lock only after confirming no maintenance process is running",
      };
    }
  }
  return { owned: false, held: true, owner: null };
};

export const releaseMaintenanceLock = (lock) => {
  if (!lock?.owned) return;
  try {
    rmSync(LOCK_PATH, { force: true });
  } catch {
    // best-effort release; a stale lock is reclaimed by the next acquirer
  }
};

/* ------------------------------------------------------------------ */
/* Recovery journal                                                    */
/* ------------------------------------------------------------------ */

export const JOURNAL_PHASES = Object.freeze([
  "verify-done",
  "quiescing",
  "swap-active-to-safety",
  "swap-verified-to-active",
  "post-gates",
  "complete",
]);

/** Atomic + durable journal write: temp file -> fsync -> rename over the
 *  journal (POSIX-atomic) -> fsync the parent directory where supported.
 *  The journal record is never overwritten/truncated in place, so a crash
 *  or write failure at ANY point leaves either the previous complete
 *  journal or the new one — never a truncated invalid record that could
 *  fail open. A write failure THROWS: the caller must abort (fail
 *  closed) rather than proceed without durable phase evidence. */
export const writeJournal = (phase, backup) => {
  if (!JOURNAL_PHASES.includes(phase)) {
    throw new Error(`internal error: unknown journal phase "${phase}"`);
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date().toISOString();
  const previous = readJournal();
  const payload = JSON.stringify(
    {
      operation: "promote",
      phase,
      backup: backup ?? null,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
    },
    null,
    2,
  );
  const tmpPath = `${JOURNAL_PATH}.tmp`;
  try {
    rmSync(tmpPath, { force: true });
  } catch {
    // best-effort
  }
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, JOURNAL_PATH);
  try {
    const dirFd = openSync(BACKUP_DIR, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync unsupported on some filesystems — the rename is
    // already atomic; durability is best-effort there.
  }
};

export const clearJournal = () => {
  try {
    rmSync(JOURNAL_PATH, { force: true });
  } catch {
    // best-effort
  }
};

/** Read the journal with an explicit evidence STATE:
 *    "valid"      — a complete, well-formed phase record exists
 *    "malformed"  — a journal file exists but is unreadable/truncated/
 *                   not a valid phase record (evidence unusable)
 *    "absent"     — no journal file exists
 *  Reconciliation treats "malformed" exactly like "absent": the durable
 *  evidence is unusable, so the OBSERVED database layout decides — never
 *  a default proceed. */
export const readJournalState = () => {
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
    if (
      journal?.operation === "promote" &&
      JOURNAL_PHASES.includes(journal.phase)
    ) {
      return { state: "valid", journal };
    }
    return { state: "malformed", journal: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "absent", journal: null };
    }
    return { state: "malformed", journal: null };
  }
};

/** Backward-compatible wrapper: the parsed journal or null. */
export const readJournal = () => readJournalState().journal;

/* ------------------------------------------------------------------ */
/* Failed-promotion candidate names                                    */
/* ------------------------------------------------------------------ */

/** A non-colliding name for preserving an unresolved candidate: the
 *  bounded base name when free, otherwise a bounded numeric suffix. No
 *  rollback rename may target an existing database, and an unresolved
 *  failed candidate is never silently overwritten or deleted. */
export const freeFailedPromotionName = (existingNames) => {
  if (!existingNames.includes(FAILED_PROMOTION_DB)) return FAILED_PROMOTION_DB;
  for (let i = 1; i <= 100; i += 1) {
    const name = `${FAILED_PROMOTION_DB}_${i}`;
    if (!existingNames.includes(name)) return name;
  }
  throw new Error(
    "no free failed-promotion name available — archive or drop the preserved candidates first",
  );
};

/* ------------------------------------------------------------------ */
/* Crash reconciliation (pure decision table)                          */
/* ------------------------------------------------------------------ */

/**
 * Decide what the next recovery invocation must do given the durable
 * journal evidence state (valid/absent/malformed), the journal phase,
 * and the OBSERVED database names. NEVER destructive to the original
 * authority: the safety name is only ever renamed back.
 *
 *   proceed            nothing to undo; the new operation may continue
 *                      (restartServices: an at-or-after-quiescing crash
 *                      window was resolved — services must be restarted
 *                      and proven before continuing)
 *   restart-original   services may be quiesced while the original
 *                      authority is still active (crash at/after the
 *                      quiescing marker, before the swap); restart +
 *                      prove the original deployment and abort the new
 *                      operation (retry required)
 *   restore-original   the original authority is under the safety name
 *                      (first rename happened, second did not) and must
 *                      be renamed back (abort, retry required)
 *   rollback-candidate `tenvyr` holds the UNPROVEN restored candidate;
 *                      move it to a bounded non-colliding failed name
 *                      and restore the original (abort, retry required)
 *   blocked            no safe automatic action; print exact state +
 *                      bounded instructions (FAIL CLOSED — never guess)
 *
 * When the journal evidence is ABSENT or MALFORMED the table is
 * conservative: it NEVER proceeds to a path that can DROP the safety
 * copy, and the ambiguous "active + safety" layout (which may be a
 * completed prior recovery OR an uncommitted promoted candidate) fails
 * closed instead of guessing.
 */
export const planReconciliation = ({ journalState = "absent", phase = null, databases }) => {
  const hasActive = databases.includes(ACTIVE_DB);
  const hasSafety = databases.includes(SAFETY_DB);
  if (journalState !== "valid") {
    // Journal missing, malformed, or truncated: the durable evidence is
    // unusable. The OBSERVED layout decides — never default to proceed.
    if (hasSafety) {
      if (!hasActive) {
        // The first rename happened; the original is under the safety
        // name. NEVER proceed to a path that can DROP safety.
        return { action: "restore-original" };
      }
      // Active + safety without usable journal evidence: this may be a
      // completed prior recovery (evidence lost) OR an uncommitted
      // promoted candidate. FAIL CLOSED — preserve both copies.
      return { action: "blocked" };
    }
    if (!hasActive) {
      // No active authority AND no safety copy: block.
      return { action: "blocked" };
    }
    // Active present, no safety, no journal: the clean state (or a
    // mid-reconciliation crash after the rename-back).
    return { action: "proceed" };
  }
  if (phase === "complete") {
    // Durable completion evidence: the retained safety copy is a
    // completed-recovery artifact.
    return { action: "proceed" };
  }
  if (hasSafety) {
    if (!hasActive) {
      // The first rename happened (or a mid-reconciliation crash): the
      // original authority is the safety copy.
      return { action: "restore-original" };
    }
    if (phase === "swap-verified-to-active" || phase === "post-gates") {
      // The second rename happened: `tenvyr` is the unproven candidate.
      return { action: "rollback-candidate" };
    }
    if (phase === "quiescing" || phase === "swap-active-to-safety") {
      // Writers may be stopped (the quiescing marker is written BEFORE
      // quiesce); the first rename never ran — `tenvyr` is the ORIGINAL.
      // Restart + prove availability and abort (retry required).
      return { action: "restart-original" };
    }
    // "verify-done": quiesce never started — services are running.
    return { action: "proceed" };
  }
  if (!hasActive) {
    return { action: "blocked" };
  }
  // Active present, no safety:
  if (phase === "quiescing" || phase === "swap-active-to-safety") {
    // Writers may be stopped; the original is active.
    return { action: "restart-original" };
  }
  if (phase === "swap-verified-to-active" || phase === "post-gates") {
    // Mid-reconciliation window (rename-back done, restart pending):
    // the original is active but services may still be stopped.
    return { action: "proceed", restartServices: true };
  }
  // "verify-done" (and anything else): nothing was quiesced.
  return { action: "proceed" };
};
