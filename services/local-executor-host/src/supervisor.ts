import { spawn, type ChildProcess } from "node:child_process";
import type { HostAgentConfig } from "./config";

/**
 * M3-S3: bounded supervision of ONE fixed command per invocation.
 *
 * Safety contract:
 * - argv array with `shell: false` — no shell, no interpolation, no eval;
 *   shell metacharacters in args are literal characters of the fixed config;
 * - `detached: true` puts the child in its own process group so
 *   `kill(-pid)` reaches the whole tree;
 * - environment is EXACTLY the configured allowlist + resolved secret
 *   references (no inherited environment);
 * - stdout/stderr are byte-bounded; exceeding a bound kills the group
 *   immediately (hard limit, not a slow leak);
 * - the wall clock kills the process group at the earlier of the invocation
 *   deadline and the configured wallTimeMs: SIGTERM to the group, then
 *   SIGKILL after a fixed grace — the escalation outcome is recorded;
 * - the caller's AbortSignal (worker shutdown / SDK run timeout) escalates
 *   the same way and is recorded as a shutdown kill;
 * - exactly one outcome is resolved, always; the caller materializes the
 *   canonical result from it.
 *
 * The host never interprets artifact URIs as local paths: the invocation is
 * passed through as opaque JSON on stdin, nothing is resolved locally.
 */

export const ESCALATION_GRACE_MS = 5_000;

/** P2: bounded model identifier contract (mirrors the orchestrator's
 *  MODEL_ID_PATTERN). Model IDs are DATA: pattern + length checked here,
 *  composed as a separate argv element, never shell-interpreted. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/\-:@+]*$/;
export const MODEL_ID_MAX_LENGTH = 256;

/** P2: fixed argv separation. When the agent declares a fixed
 *  `modelArgvPrefix` (e.g. ["--model"]) and the invocation carries a
 *  validated requested model id, the composed argv is
 *  `[...args, ...modelArgvPrefix, modelId]` — the prefix is fixed operator
 *  configuration and the model id is one bounded data element. Without a
 *  model, argv is exactly the configured args (Runtime default). */
export function composeArgv(
  profile: Pick<HostAgentConfig, "args" | "modelArgvPrefix">,
  requestedModelId: string | undefined,
): string[] {
  if (
    requestedModelId === undefined ||
    profile.modelArgvPrefix === undefined ||
    profile.modelArgvPrefix.length === 0
  ) {
    return profile.args;
  }
  return [...profile.args, ...profile.modelArgvPrefix, requestedModelId];
}

export type KillTrigger = "wall_time" | "invocation_deadline" | "shutdown";

export type ProcessOutcome =
  | {
      kind: "succeeded";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      kind: "failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      kind: "spawn_failed";
      message: string;
    }
  | {
      kind: "killed";
      trigger: KillTrigger;
      finalSignal: "SIGTERM" | "SIGKILL";
      stdout: string;
      stderr: string;
    }
  | {
      kind: "output_limit";
      stream: "stdout" | "stderr";
      stdout: string;
      stderr: string;
    };

export type SupervisorInput = {
  profile: HostAgentConfig;
  /** Resolved child environment (allowlist + secrets); values never logged. */
  env: Record<string, string>;
  /** Opaque canonical input delivered on the child's bounded stdin. */
  input: unknown;
  /** Bounded requested model id (validated before spawn); composed behind
   *  the agent's fixed modelArgvPrefix when both exist. */
  requestedModelId?: string;
  /** Aborts on worker shutdown / SDK run timeout; escalates the group kill. */
  signal: AbortSignal;
  /** ISO deadline from the invocation, when present. */
  invocationDeadlineAt?: string;
  /** Called with the child pid once the process has spawned (state files). */
  onSpawn?: (pid: number) => void;
  /** Escalation grace between SIGTERM and SIGKILL (test override). */
  escalationGraceMs?: number;
  /**
   * PP1 — Pivot Invariant 1: the validated Tenvyr-authoritative execution
   * path (already resolved + containment-checked by resolveExecutionCwd).
   * When present it wins over the static profile.cwd; absent → profile.cwd
   * (backward compatible).
   */
  cwdOverride?: string;
};

export async function superviseProcess(
  input: SupervisorInput,
): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    const { profile, env, signal } = input;
    const child = spawn(
      profile.command,
      composeArgv(profile, input.requestedModelId),
      {
        cwd: input.cwdOverride ?? profile.cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let limitHit: "stdout" | "stderr" | null = null;
    let killTrigger: KillTrigger = "wall_time";
    const timers: NodeJS.Timeout[] = [];

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const killGroup = (
      childProcess: ChildProcess,
      signalName: "SIGTERM" | "SIGKILL",
    ): void => {
      if (childProcess.pid === undefined || childProcess.exitCode !== null) {
        return;
      }
      try {
        // Negative pid targets the child's process group (detached: true).
        process.kill(-childProcess.pid, signalName);
      } catch (error) {
        // ESRCH: the group is already gone — the exit handler settles.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn("Process group kill failed", {
            agent: profile.agent,
            pid: childProcess.pid,
            signal: signalName,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const escalate = (trigger: KillTrigger): void => {
      killTrigger = trigger;
      killGroup(child, "SIGTERM");
      const killTimer = setTimeout(() => {
        killGroup(child, "SIGKILL");
      }, input.escalationGraceMs ?? ESCALATION_GRACE_MS);
      timers.push(killTimer);
    };

    const onAbort = (): void => escalate("shutdown");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    // Byte-bounded capture; exceeding the bound kills immediately.
    const boundStream = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (settled || limitHit) return;
      const limit =
        stream === "stdout" ? profile.maxStdoutBytes : profile.maxStderrBytes;
      const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (currentBytes + chunk.length > limit) {
        limitHit = stream;
        killGroup(child, "SIGKILL");
        return;
      }
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        stdout += chunk.toString("utf8");
      } else {
        stderrBytes += chunk.length;
        stderr += chunk.toString("utf8");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => boundStream("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => boundStream("stderr", chunk));

    // Opaque bounded canonical input on stdin, then EOF.
    child.stdin?.on("error", () => {
      // Ignored: child exited before reading stdin (EPIPE/ERR_STREAM_WRITE_AFTER_END)
    });
    try {
      child.stdin?.write(JSON.stringify(input.input));
    } catch {
      // A stdin write failure surfaces through the exit path below.
    }
    child.stdin?.end();

    child.on("error", (error) => {
      settle({ kind: "spawn_failed", message: error.message });
    });

    child.on("spawn", () => {
      if (child.pid !== undefined) input.onSpawn?.(child.pid);
    });

    child.on("exit", (code, exitSignal) => {
      if (settled) return;
      // The child is gone but its process group may still contain surviving
      // descendants: kill the group so a normal exit can never leak orphans.
      // (killGroup's exitCode guard would no-op here, so kill the group id
      // directly; ESRCH means no members survived.)
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // No surviving group members.
        }
      }
      if (limitHit) {
        settle({ kind: "output_limit", stream: limitHit, stdout, stderr });
        return;
      }
      if (exitSignal === "SIGTERM" || exitSignal === "SIGKILL") {
        settle({
          kind: "killed",
          trigger: killTrigger,
          finalSignal: exitSignal,
          stdout,
          stderr,
        });
        return;
      }
      if (code === 0) {
        settle({ kind: "succeeded", exitCode: 0, stdout, stderr });
        return;
      }
      settle({ kind: "failed", exitCode: code ?? -1, stdout, stderr });
    });

    // Wall clock: the earlier of the invocation deadline and wallTimeMs. A
    // deadline already in the past fires immediately (the orchestrator
    // already considers the attempt timed out).
    const invocationDeadlineMs = input.invocationDeadlineAt
      ? Date.parse(input.invocationDeadlineAt)
      : NaN;
    const hasInvocationDeadline = !Number.isNaN(invocationDeadlineMs);
    const killAt = hasInvocationDeadline
      ? Math.min(Date.now() + profile.wallTimeMs, invocationDeadlineMs)
      : Date.now() + profile.wallTimeMs;
    const termTimer = setTimeout(
      () => {
        escalate(hasInvocationDeadline ? "invocation_deadline" : "wall_time");
      },
      Math.max(0, killAt - Date.now()),
    );
    timers.push(termTimer);
  });
}
