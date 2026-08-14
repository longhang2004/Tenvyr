import { spawn } from "node:child_process";
import {
  CLI_BOUNDS,
  type CliProfileV1,
  type StatusReasonCode,
} from "../executors/runtime-connection";

/**
 * M8-S3: bounded availability/version probe for a fixed CLI profile.
 *
 * The probe runs the operator-configured fixed command with a MINIMUM
 * environment (only the allowlisted env + resolved secret references), a
 * wall-clock deadline with SIGTERM -> SIGKILL group escalation, and per-stream
 * byte bounds. No shell, no pipeline input, no output sniffing: exit-code
 * mapping (auth) is operator-declared, never inferred. Outcomes map to
 * bounded status reason codes; the probe NEVER returns command output.
 */

export const PROBE_ESCALATION_GRACE_MS = 250;

export type CliProbeOutcome =
  | {
      ok: true;
      version?: string;
      reasonCode: "none";
      stdoutBytes: number;
      durationMs: number;
    }
  | {
      ok: false;
      reasonCode: StatusReasonCode;
      stdoutBytes: number;
      durationMs: number;
    };

export async function runCliProbe(
  profile: CliProfileV1,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CliProbeOutcome> {
  const started = Date.now();
  const wallTimeMs =
    profile.probe.wallTimeMs ?? CLI_BOUNDS.probeWallTimeMsDefault;
  const maxOutputBytes =
    profile.probe.maxOutputBytes ?? CLI_BOUNDS.probeOutputBytesDefault;
  const probeEnv = resolveProbeEnvironment(profile, environment);
  if (!probeEnv) {
    return {
      ok: false,
      reasonCode: "command-failed",
      stdoutBytes: 0,
      durationMs: Date.now() - started,
    };
  }

  return new Promise<CliProbeOutcome>((resolve) => {
    const child = spawn(profile.command, profile.probe.args, {
      cwd: profile.cwd,
      env: probeEnv,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBytes = 0;
    let stdoutChunks: Buffer[] = [];
    let stdoutHitLimit = false;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const settle = (outcome: CliProbeOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(outcome);
    };

    const killGroup = (signalName: "SIGTERM" | "SIGKILL"): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        // Negative pid targets the child's process group (detached: true).
        process.kill(-child.pid, signalName);
      } catch {
        // ESRCH: the group is already gone — the exit handler settles.
      }
    };

    const escalate = (): void => {
      timedOut = true;
      killGroup("SIGTERM");
      timers.push(
        setTimeout(() => {
          killGroup("SIGKILL");
        }, PROBE_ESCALATION_GRACE_MS),
      );
    };

    const deadline = setTimeout(escalate, wallTimeMs);
    timers.push(deadline);

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = true;
      const reasonCode: StatusReasonCode =
        error.code === "ENOENT" ? "missing-executable" : "command-failed";
      settle({
        ok: false,
        reasonCode,
        stdoutBytes,
        durationMs: Date.now() - started,
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutHitLimit) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        stdoutHitLimit = true;
        stdoutChunks = [];
        escalate();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", () => {
      // stderr is drained but never captured: probe outcomes never carry
      // command output, so nothing to bound or record.
    });

    child.on("close", (code) => {
      if (settled) return;
      const durationMs = Date.now() - started;
      if (spawnFailed) return;
      // The output bound is a malformed-output verdict even though the
      // process had to be killed to enforce it.
      if (stdoutHitLimit) {
        settle({
          ok: false,
          reasonCode: "malformed-output",
          stdoutBytes,
          durationMs,
        });
        return;
      }
      if (timedOut) {
        settle({
          ok: false,
          reasonCode: "timeout",
          stdoutBytes,
          durationMs,
        });
        return;
      }
      if (code !== 0) {
        const authExitCodes = profile.probe.authExitCodes ?? [];
        const authAnyNonZero = profile.probe.authAnyNonZero === true;
        const authRequired =
          authAnyNonZero || authExitCodes.includes(code);
        settle({
          ok: false,
          reasonCode: authRequired ? "auth-required" : "command-failed",
          stdoutBytes,
          durationMs,
        });
        return;
      }
      if (profile.probe.expectsVersion !== true) {
        // Auth/informational probe: stdout is never parsed, so auth output
        // can never leak into the tested version.
        settle({
          ok: true,
          reasonCode: "none",
          stdoutBytes,
          durationMs,
        });
        return;
      }
      const version = extractVersion(Buffer.concat(stdoutChunks));
      if (version === null) {
        settle({
          ok: false,
          reasonCode: "malformed-output",
          stdoutBytes,
          durationMs,
        });
        return;
      }
      const outcome: CliProbeOutcome = {
        ok: true,
        reasonCode: "none",
        stdoutBytes,
        durationMs,
      };
      if (version !== undefined) outcome.version = version;
      settle(outcome);
    });
  });
}

/**
 * Extracts a bounded version from probe stdout: the first version-like token
 * of the first non-empty line (real CLIs append suffixes, e.g. Claude Code's
 * "2.1.97 (Claude Code)"). A token must start with a digit (or `v` + digit)
 * and match the version charset; empty or hostile output is malformed — the
 * probe never echoes arbitrary command output.
 */
function extractVersion(stdout: Buffer): string | undefined | null {
  const text = stdout.toString("utf8");
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return null;
  const token = firstLine.split(/\s+/).find((part) => /^v?\d/.test(part));
  if (token === undefined) return null;
  if (
    token.length > 128 ||
    !/^[A-Za-z0-9._+\-]+$/.test(token)
  ) {
    return null;
  }
  return token;
}

/** Minimum environment: allowlisted vars + resolved secret references only.
 *  Missing referenced env values are a deterministic probe failure. */
function resolveProbeEnvironment(
  profile: CliProfileV1,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | null {
  const result: NodeJS.ProcessEnv = {};
  for (const [child, hostEnv] of Object.entries(profile.envAllowlist ?? {})) {
    const value = environment[hostEnv];
    if (value === undefined) return null;
    result[child] = value;
  }
  for (const [child, hostEnv] of Object.entries(profile.secrets ?? {})) {
    const value = environment[hostEnv];
    if (value === undefined) return null;
    result[child] = value;
  }
  return result;
}
