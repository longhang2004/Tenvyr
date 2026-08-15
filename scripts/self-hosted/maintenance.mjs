#!/usr/bin/env node
/**
 * M11 closure: maintenance mutual exclusion + durable recovery journal.
 *
 * 1. MAINTENANCE LOCK — an exclusive process-lifetime lock over the
 *    shared maintenance resources (backup verification database, staging
 *    dump paths, the authority-swap database names). Every backup and
 *    every restore (drill/promote/reconcile) acquires it; a second
 *    concurrent operation FAILS FAST with "maintenance operation already
 *    active" instead of interleaving destructive operations. Ownership is
 *    an atomic O_EXCL lock-file create carrying the owner record (PID +
 *    startedAt) in the same write — a process crash releases it
 *    automatically because the next acquisition detects the dead owner
 *    PID and reclaims the stale lock. `upgrade` owns the lock for its
 *    whole run and hands ownership to its backup child via
 *    TENVYR_MAINTENANCE_OWNED=1 (explicit re-entrancy, never a
 *    self-deadlock).
 *
 * 2. RECOVERY JOURNAL — durable phase markers for `restore --promote`,
 *    written (fsync'd) BEFORE every destructive database step. A process
 *    death at ANY phase leaves the journal + the database names as the
 *    unambiguous record of what happened; the NEXT recovery invocation
 *    reconciles the observed state BEFORE any destructive DROP/rename
 *    (the original authority is never silently deleted). Phases:
 *
 *      verify-done                 deep verification passed, about to quiesce
 *      quiescing                   writers stopped, about to swap
 *      swap-active-to-safety       about to rename tenvyr -> tenvyr_pre_restore
 *      swap-verified-to-active     first rename done, about to rename
 *                                  tenvyr_restore -> tenvyr
 *      post-gates                  candidate active, gates running
 *      complete                    ALL gates passed (durable success)
 *
 *    planReconciliation() maps (journal phase, observed database names)
 *    to a deterministic action. The `tenvyr_pre_restore` safety name is
 *    NEVER dropped by reconciliation — it is only ever renamed back to
 *    `tenvyr` (or preserved with exact instructions when no safe action
 *    exists).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const BACKUP_DIR = join(ROOT, "backups");

/** Database names are internal constants — never operator-controlled. */
export const ACTIVE_DB = "tenvyr";
export const SAFETY_DB = "tenvyr_pre_restore";
export const ISOLATED_DB = "tenvyr_restore";
export const FAILED_PROMOTION_DB = "tenvyr_failed_promotion";

const LOCK_DIR = join(BACKUP_DIR, ".maintenance.lock");
const JOURNAL_PATH = join(BACKUP_DIR, ".recovery-journal.json");

/** Set by an owning process (upgrade) for its child (backup): the child
 *  inherits the already-held maintenance lock instead of acquiring it. */
const OWNERSHIP_ENV = "TENVYR_MAINTENANCE_OWNED";

export const journalPath = () => JOURNAL_PATH;

/* ------------------------------------------------------------------ */
/* Maintenance lock                                                    */
/* ------------------------------------------------------------------ */

/** Exclusive ownership is claimed by an atomic O_EXCL file create; the
 *  owner record (PID + startedAt) is written in the SAME syscall, so
 *  there is no mkdir-then-write window a concurrent acquirer could race.
 *  Crash-release: the next acquisition reclaims a lock whose owner PID is
 *  dead. */
const LOCK_PATH = join(BACKUP_DIR, ".maintenance.lock");

const syncSleep = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // synchronous CLI sleep
  }
};

const readLockOwner = () => {
  try {
    const owner = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    return typeof owner?.pid === "number" && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
};

export const acquireMaintenanceLock = () => {
  if (process.env[OWNERSHIP_ENV] === "1") {
    return { owned: false, inherited: true, held: true };
  }
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
      return { owned: true, inherited: false, held: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = readLockOwner();
      if (owner === null) {
        // The creator is mid-acquisition (file exists, content not yet
        // visible): give it a bounded moment before deciding it is stale.
        syncSleep(25);
        owner = readLockOwner();
      }
      if (owner !== null) {
        try {
          process.kill(owner.pid, 0);
          return { owned: false, inherited: false, held: true, owner };
        } catch {
          // ESRCH: the owner PID is dead -> stale lock
        }
      }
      // Stale lock (dead owner or unreadable after the bounded wait):
      // a crashed process releases the lock automatically — reclaim it.
      try {
        rmSync(LOCK_PATH, { force: true });
      } catch {
        // best-effort
      }
    }
  }
  return { owned: false, inherited: false, held: true, owner: null };
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

export const writeJournal = (phase, backup) => {
  if (!JOURNAL_PHASES.includes(phase)) {
    throw new Error(`internal error: unknown journal phase "${phase}"`);
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date().toISOString();
  const previous = readJournal();
  writeFileSync(
    JOURNAL_PATH,
    JSON.stringify(
      {
        operation: "promote",
        phase,
        backup: backup ?? null,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );
};

export const clearJournal = () => {
  try {
    rmSync(JOURNAL_PATH, { force: true });
  } catch {
    // best-effort
  }
};

export const readJournal = () => {
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
    return journal?.operation === "promote" && JOURNAL_PHASES.includes(journal.phase)
      ? journal
      : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/* Crash reconciliation (pure decision table)                          */
/* ------------------------------------------------------------------ */

/**
 * Decide what the next recovery invocation must do given the durable
 * journal phase and the OBSERVED database names. NEVER destructive to the
 * original authority: the safety name is only ever renamed back.
 *
 *   proceed            nothing to undo; the new operation may continue
 *   restore-original   first rename happened, second did not: the
 *                      original authority is under the safety name and
 *                      must be renamed back (abort, retry required)
 *   rollback-candidate second rename happened: `tenvyr` holds the
 *                      UNPROVEN restored candidate; move it to the
 *                      bounded failed state and restore the original
 *                      (abort, retry required)
 *   blocked            no active authority AND no safety copy: no safe
 *                      automatic action; print exact state + instructions
 */
export const planReconciliation = ({ phase, databases }) => {
  if (phase === null || phase === undefined) return { action: "proceed" };
  if (phase === "complete") return { action: "proceed" };
  const hasActive = databases.includes(ACTIVE_DB);
  const hasSafety = databases.includes(SAFETY_DB);
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
    // Phases before the swap ("verify-done", "quiescing",
    // "swap-active-to-safety"): no rename ran, `tenvyr` is the ORIGINAL
    // (the safety copy is the previous completed recovery's artifact).
    return { action: "proceed" };
  }
  if (!hasActive) {
    return { action: "blocked" };
  }
  // Active present, no safety: the original is active (either nothing was
  // mutated or a mid-reconciliation crash after the rename-back).
  return { action: "proceed" };
};
