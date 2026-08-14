import { runCliProbe } from "./cli-probe";
import type { CliProfileV1 } from "../executors/runtime-connection";

/**
 * Deterministic fake CLIs: `node -e <script>` under process.execPath. No
 * shell is involved anywhere — argv is a fixed array, exactly like a real
 * operator-configured profile.
 */
const node = (script: string): CliProfileV1 => ({
  command: process.execPath,
  args: [],
  probe: { args: ["-e", script], expectsVersion: true },
});

describe("runCliProbe", () => {
  it("reports the version from the first non-empty stdout line", async () => {
    const outcome = await runCliProbe(
      node("console.log(''); console.log('0.147.0'); console.log('ignored')"),
    );
    expect(outcome).toMatchObject({ ok: true, version: "0.147.0" });
  });

  it("treats empty or hostile stdout as malformed output", async () => {
    const empty = await runCliProbe(node(""));
    expect(empty).toMatchObject({ ok: false, reasonCode: "malformed-output" });
    const hostile = await runCliProbe(
      node("console.log('0.147.0; rm -rf /')"),
    );
    expect(hostile).toMatchObject({ ok: false, reasonCode: "malformed-output" });
  });

  it("maps a missing executable to missing-executable", async () => {
    const outcome = await runCliProbe({
      command: "/nonexistent/tenvyr-fake-codex",
      args: [],
      probe: { args: ["--version"] },
    });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "missing-executable" });
  });

  it("maps declared auth exit codes to auth-required, others to command-failed", async () => {
    const auth = await runCliProbe(
      { ...node("process.exit(2)"), probe: { args: ["-e", "process.exit(2)"], authExitCodes: [2] } },
    );
    expect(auth).toMatchObject({ ok: false, reasonCode: "auth-required" });
    const failed = await runCliProbe(node("process.exit(3)"));
    expect(failed).toMatchObject({ ok: false, reasonCode: "command-failed" });
  });

  it("enforces the wall-clock deadline and kills the process group", async () => {
    const started = Date.now();
    const outcome = await runCliProbe({
      ...node("setTimeout(() => {}, 60_000)"),
      probe: { args: ["-e", "setTimeout(() => {}, 60_000)"], wallTimeMs: 150 },
    });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("enforces the output byte bound", async () => {
    const outcome = await runCliProbe({
      ...node("console.log('x'.repeat(200_000))"),
      probe: {
        args: ["-e", "console.log('x'.repeat(200_000))"],
        maxOutputBytes: 1024,
      },
    });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "malformed-output" });
  });

  it("runs with the minimum environment: allowlisted vars only, secrets resolved at spawn", async () => {
    const outcome = await runCliProbe(
      {
        command: process.execPath,
        args: [],
        envAllowlist: { PROBE_ONLY: "PROBE_ONLY" },
        probe: {
          args: [
            "-e",
            "console.log('1.0_' + (process.env.PROBE_ONLY || 'none') + '_' + (process.env.HOME || 'none'))",
          ],
          expectsVersion: true,
        },
      },
      { PROBE_ONLY: "allowlisted-value", HOME: "/home/someone" },
    );
    // HOME is NOT in the allowlist: the probe never sees the wider host env.
    expect(outcome).toMatchObject({
      ok: true,
      version: "1.0_allowlisted-value_none",
    });
  });

  it("fails deterministically when a referenced secret is missing", async () => {
    const outcome = await runCliProbe(
      {
        command: process.execPath,
        args: [],
        secrets: { CODEX_API_KEY: "CODEX_API_KEY" },
        probe: { args: ["-e", "console.log('unreachable')"] },
      },
      {},
    );
    expect(outcome).toMatchObject({ ok: false, reasonCode: "command-failed" });
  });

  it("never returns command output beyond the bounded version", async () => {
    const outcome = await runCliProbe(
      node("console.log('0.147.0'); console.log('sk-leak-on-line-2')"),
    );
    expect(outcome).toMatchObject({ ok: true, version: "0.147.0" });
    const rendered = JSON.stringify(outcome);
    expect(rendered).not.toContain("sk-leak-on-line-2");
    // The outcome shape is bounded: identity/version metadata only, never
    // raw command output.
    expect(Object.keys(outcome).sort()).toEqual([
      "durationMs",
      "ok",
      "reasonCode",
      "stdoutBytes",
      "version",
    ]);
  });
});
