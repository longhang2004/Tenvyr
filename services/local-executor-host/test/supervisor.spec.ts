import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { superviseProcess, type SupervisorInput } from "../src/supervisor";
import type { HostAgentConfig } from "../src/config";
import { isProcessAlive } from "../src/state";

const node = process.execPath;

const profile = (
  overrides: Partial<HostAgentConfig> = {},
): HostAgentConfig => ({
  agent: "test-agent",
  command: node,
  args: ["-e", "console.log('hello stdout'); console.error('hello stderr')"],
  cwd: process.cwd(),
  env: {},
  secrets: {},
  wallTimeMs: 30_000,
  maxStdoutBytes: 65_536,
  maxStderrBytes: 65_536,
  port: 4199,
  bearerTokenEnv: "UNUSED",
  ...overrides,
});

const input = (overrides: Partial<SupervisorInput> = {}): SupervisorInput => ({
  profile: profile(),
  env: {},
  input: { hello: "world" },
  signal: new AbortController().signal,
  escalationGraceMs: 200,
  ...overrides,
});

describe("superviseProcess", () => {
  it("captures bounded stdout/stderr and reports success on exit 0", async () => {
    const outcome = await superviseProcess(input());

    expect(outcome).toMatchObject({
      kind: "succeeded",
      exitCode: 0,
      stdout: "hello stdout\n",
      stderr: "hello stderr\n",
    });
  });

  it("reports failure with the exit code on a non-zero exit", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: ["-e", "console.error('boom'); process.exit(3)"],
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "failed",
      exitCode: 3,
      stderr: "boom\n",
    });
  });

  it("reports spawn_failed for an unspawnable command", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          command: "/nonexistent/executable-xyz",
          args: [],
        }),
      }),
    );

    expect(outcome.kind).toBe("spawn_failed");
  });

  it("never invokes a shell: metacharacters in argv stay literal", async () => {
    const hostile = [";", "|", "&&", "$(touch /tmp/tenvyr-pwned)", "`id`"];
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            "console.log(process.argv.slice(1).join('|'))",
            ...hostile,
          ],
        }),
      }),
    );

    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind === "succeeded") {
      // Every literal metacharacter arrived as plain argv — nothing was
      // interpreted, expanded, or evaluated by a shell.
      expect(outcome.stdout).toContain(hostile.join("|"));
      expect(outcome.stdout).not.toContain("\u0000");
    }
    // Proof no shell evaluation happened: the $(...) payload never ran.
    expect(fs.existsSync("/tmp/tenvyr-pwned")).toBe(false);
  });

  it("delivers the canonical input on bounded stdin", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).hello))",
          ],
        }),
      }),
    );

    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind === "succeeded") expect(outcome.stdout).toBe("world\n");
  });

  it("kills the process group at the wall clock and records escalation", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: ["-e", "setInterval(() => {}, 1000)"],
          wallTimeMs: 200,
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "killed",
      trigger: "wall_time",
      finalSignal: "SIGTERM",
    });
  });

  it("kills at the earlier invocation deadline with the deadline trigger", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: ["-e", "setInterval(() => {}, 1000)"],
          wallTimeMs: 60_000,
        }),
        invocationDeadlineAt: new Date(Date.now() + 200).toISOString(),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "killed",
      trigger: "invocation_deadline",
    });
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
          ],
          wallTimeMs: 500,
        }),
        escalationGraceMs: 150,
      }),
    );

    expect(outcome).toMatchObject({
      kind: "killed",
      trigger: "wall_time",
      finalSignal: "SIGKILL",
    });
  });

  it("kills the process group when the caller aborts (shutdown)", async () => {
    const controller = new AbortController();
    const outcomePromise = superviseProcess(
      input({
        profile: profile({
          args: ["-e", "setInterval(() => {}, 1000)"],
          wallTimeMs: 60_000,
        }),
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 100);

    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      kind: "killed",
      trigger: "shutdown",
      finalSignal: "SIGTERM",
    });
  });

  it("kills the group and reports output_limit when stdout exceeds the bound", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            "process.stdout.write('x'.repeat(200_000)); setInterval(() => {}, 1000)",
          ],
          maxStdoutBytes: 1024,
          wallTimeMs: 60_000,
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "output_limit",
      stream: "stdout",
    });
  });

  it("kills the group and reports output_limit when stderr exceeds the bound", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            "process.stderr.write('e'.repeat(200_000)); setInterval(() => {}, 1000)",
          ],
          maxStderrBytes: 1024,
          wallTimeMs: 60_000,
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "output_limit",
      stream: "stderr",
    });
  });

  it("enforces output bounds in bytes for multi-byte UTF-8", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            "process.stdout.write('🙂'); setTimeout(() => process.stdout.write('🙂'), 25); setInterval(() => {}, 1000)",
          ],
          maxStdoutBytes: 6,
          wallTimeMs: 60_000,
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "output_limit",
      stream: "stdout",
    });
  });

  it("notifies onSpawn with the child pid", async () => {
    const pids: number[] = [];
    await superviseProcess(
      input({
        onSpawn: (pid) => pids.push(pid),
      }),
    );

    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });

  it("kills surviving descendants when the child exits normally", async () => {
    // The fixture spawns a NON-detached grandchild (same process group)
    // then force-exits like a real CLI parent would; the exit handler must
    // kill the surviving descendant.
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: [
            "-e",
            `const {spawn}=require('child_process'); const g=spawn(${JSON.stringify(
              process.execPath,
            )},['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); g.once('spawn',()=>{console.log('grandchild-'+g.pid); process.exit(0);});`,
          ],
        }),
      }),
    );

    expect(outcome.kind).toBe("succeeded");
    // The grandchild's pid was reported on stdout before the parent exited.
    if (outcome.kind === "succeeded") {
      const match = /grandchild-(\d+)/.exec(outcome.stdout);
      expect(match).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(isProcessAlive(Number(match?.[1]))).toBe(false);
    }
  });

  it("fires immediately when the invocation deadline is already in the past", async () => {
    const outcome = await superviseProcess(
      input({
        profile: profile({
          args: ["-e", "setInterval(() => {}, 1000)"],
          wallTimeMs: 60_000,
        }),
        invocationDeadlineAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "killed",
      trigger: "invocation_deadline",
    });
  });
});
