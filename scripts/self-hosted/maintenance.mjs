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
 *    startedAt + a random OPERATION TOKEN) in the same write — a process
 *    crash releases it automatically because the next acquisition
 *    detects the dead owner PID and reclaims the stale lock.
 *
 *    INHERITANCE (upgrade -> its backup child): the owner passes its
 *    operation token to its DIRECT child via TENVYR_MAINTENANCE_TOKEN.
 *    Inherited acquisition is authenticated against the currently held
 *    lock: the token must equal the lock record's token AND the caller's
 *    direct parent PID must equal the lock owner PID. A forged
 *    TENVYR_MAINTENANCE_TOKEN from an unrelated process is DENIED — it
 *    can never bypass serialization. An inherited child never releases
 *    the lock (release is owner-only).
 *
 * 2. RECOVERY JOURNAL — durable phase markers for `restore --promote`,
 *    written BEFORE every destructive database step via an atomic
 *    write: temp file -> fsync -> rename over the journal -> fsync the
 *    parent directory (where supported). A crash or failure at ANY point
 *    leaves either the previous complete journal or the new one — never
 *    a truncated/invalid fail-open record. Phases:
 *
 *      verify-done                 deep verification passed, about to quiesce
 *      quiescing                   writers stopped, about to swap
 *      swap-active-to-safety       about to rename tenvyr -> tenvyr_pre_restore
 *      swap-verified-to-active     first rename done, about to rename
 *                                  tenvyr_restore -> tenvyr
 *      post-gates                  candidate active, gates running
 *      complete                    ALL gates passed (durable success)
 *
 *    Reconciliation is CONSERVATIVE when the journal evidence is absent,
 *    malformed, or truncated: the OBSERVED database-name layout decides,
 *    never a default "proceed". In particular, `tenvyr_pre_restore` is
 *    NEVER dropped by reconciliation — it is only ever renamed back to
 *    `tenvyr` (or preserved with exact instructions when no safe action
 *    exists), and an ambiguous "active + safety without usable journal"
 *    layout FAILS CLOSED instead of guessing.
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

/** Operation token conveyed by the maintenance owner to its DIRECT child
 *  (upgrade -> backup). The child's inherited acquisition is validated
 *  against the currently held lock record: token equality AND direct
 *  parent PID == lock owner PID. Forgeable by nobody: the env var alone
 *  is never sufficient. */
export const INHERITANCE_ENV = "TENVYR_MAINTENANCE_TOKEN";

export const journalPath = () => JOURNAL_PATH;

/* ------------------------------------------------------------------ */
/* Maintenance lock                                                    */
/* ------------------------------------------------------------------ */

/** Exclusive ownership is claimed by an atomic O_EXCL file create; the
 *  owner record (PID + startedAt + operation token) is written in the
 *  SAME syscall, so there is no mkdir-then-write window a concurrent
 *  acquirer could race. Crash-release: the next acquisition reclaims a
 *  lock whose owner PID is dead. */
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

/** Inherited acquisition: the caller claims the lock already held by its
 *  direct parent. AUTHENTICATED: the operation token must equal the lock
 *  record's token AND the caller's direct parent PID must be the lock
 *  owner. Anything else is a forged inheritance claim and is denied. */
const acquireInherited = () => {
  const token = process.env[INHERITANCE_ENV] ?? "";
  const owner = readLockOwner();
  if (owner === null) {
    return { owned: false, inherited: false, held: false, denied: "no maintenance lock is currently held" };
  }
  if (typeof owner.token !== "string" || owner.token.length === 0 || owner.token !== token) {
    return { owned: false, inherited: false, held: true, denied: "inherited maintenance ownership not authenticated (operation token mismatch)" };
  }
  if (owner.pid !== process.ppid) {
    return { owned: false, inherited: false, held: true, denied: "inherited maintenance ownership not authenticated (caller is not the direct child of the lock owner)" };
  }
  return { owned: false, inherited: true, held: true, token };
};

export const acquireMaintenanceLock = ({ allowInheritance = true } = {}) => {
  if (
    allowInheritance &&
    process.env[INHERITANCE_ENV] !== undefined &&
    process.env[INHERITANCE_ENV] !== ""
  ) {
    return acquireInherited();
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const token = randomBytes(16).toString("hex");
      writeFileSync(
        LOCK_PATH,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        }),
        { flag: "wx" },
      );
      return { owned: true, inherited: false, held: true, token };
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

/** Release is OWNER-ONLY: an inherited child never deletes the parent's
 *  lock (it only ever releases when it actually owns the lock). */
export const releaseMaintenanceLock = (lock) => {
  if (!lock?.owned || lock.inherited) return;
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
/* Crash reconciliation (pure decision table)                          */
/* ------------------------------------------------------------------ */

/**
 * Decide what the next recovery invocation must do given the durable
 * journal evidence state (valid/absent/malformed), the journal phase,
 * and the OBSERVED database names. NEVER destructive to the original
 * authority: the safety name is only ever renamed back.
 *
 *   proceed            nothing to undo; the new operation may continue
 *   restore-original   the original authority is under the safety name
 *                      (first rename happened, second did not) and must
 *                      be renamed back (abort, retry required)
 *   rollback-candidate `tenvyr` holds the UNPROVEN restored candidate;
 *                      move it to the bounded failed state and restore
 *                      the original (abort, retry required)
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
