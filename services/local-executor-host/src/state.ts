import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * M3-S3: per-agent run state files implement the restart/orphan policy.
 *
 * Policy (defined before launch, enforced on startup):
 * - while a run is active, the host keeps `<stateDir>/<agent>.json` with the
 *   invocation id, pid, start time, and kill time;
 * - if the host crashes/restarts with a state file whose pid is still alive,
 *   the orphaned process group is TERMINATED (SIGTERM, then SIGKILL after
 *   the escalation grace) — the host never adopts an orphan it cannot
 *   supervise, and never re-spawns the same invocation;
 * - the abandoned invocation is not re-run: the Orchestrator's supervision
 *   times the attempt out and workflow retry creates a NEW invocation;
 * - a clean run clears its state file on completion.
 */

export type RunState = {
  invocationId: string;
  pid: number;
  startedAt: string;
  killAt: string;
};

export const ORPHAN_TERMINATION_GRACE_MS = 5_000;

export function readRunState(stateDir: string, agent: string): RunState | null {
  const file = stateFile(stateDir, agent);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw) as RunState;
    if (
      typeof value.invocationId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.killAt !== "string"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeRunState(
  stateDir: string,
  agent: string,
  state: RunState,
): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = stateFile(stateDir, agent);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
}

export function clearRunState(stateDir: string, agent: string): void {
  try {
    fs.unlinkSync(stateFile(stateDir, agent));
  } catch {
    // Absent state file is the normal case.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killProcessGroup(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

/**
 * Startup orphan sweep for one agent: terminate any still-alive process
 * group recorded by a previous host run and clear the state file. Returns
 * the terminated invocation id, or null when there was no live orphan.
 *
 * PID reuse guard: the recorded process start time is verified against the
 * live process before anything is killed — a stale state file whose pid now
 * belongs to an unrelated process is cleared without touching it. When the
 * identity cannot be verified (e.g. `ps` unavailable in a restricted
 * environment), termination is SKIPPED with a warning: killing an innocent
 * process group is worse than leaving an orphan, and the orchestrator times
 * the abandoned attempt out anyway. `verify` is injectable for tests.
 */
export async function terminateOrphan(
  stateDir: string,
  agent: string,
  graceMs = ORPHAN_TERMINATION_GRACE_MS,
  verify: (pid: number, recordedMs: number) => boolean =
    processStartTimeMatches,
): Promise<string | null> {
  const state = readRunState(stateDir, agent);
  if (!state) return null;
  if (!isProcessAlive(state.pid)) {
    clearRunState(stateDir, agent);
    return null;
  }
  const startedAtMs = Date.parse(state.startedAt);
  if (Number.isNaN(startedAtMs) || !verify(state.pid, startedAtMs)) {
    // The pid belongs to a different process (pid reuse after a crash) or
    // its identity cannot be verified: never kill an innocent group.
    console.warn("Skipping orphan termination: recorded pid identity cannot be verified", {
      agent,
      invocationId: state.invocationId,
      pid: state.pid,
    });
    clearRunState(stateDir, agent);
    return null;
  }
  killProcessGroup(state.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (isProcessAlive(state.pid)) {
    killProcessGroup(state.pid, "SIGKILL");
  }
  clearRunState(stateDir, agent);
  return state.invocationId;
}

/**
 * Reads a live process start time via `ps -o lstart=` (works on macOS and
 * Linux without /proc assumptions) and compares it to the recorded time
 * within a tolerance. Returns false when the identity cannot be verified —
 * the caller must then refuse to kill.
 */
export function processStartTimeMatches(pid: number, recordedMs: number): boolean {
  let output: string;
  try {
    output = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 2_000 },
    ).trim();
  } catch {
    return false;
  }
  // Both macOS/BSD and GNU ps emit `EEE MMM d HH:mm:ss yyyy` for lstart,
  // which Date.parse understands natively.
  const liveMs = Date.parse(output);
  if (Number.isNaN(liveMs)) return false;
  return Math.abs(liveMs - recordedMs) <= 2_000;
}

function stateFile(stateDir: string, agent: string): string {
  return path.join(stateDir, `${agent}.json`);
}
