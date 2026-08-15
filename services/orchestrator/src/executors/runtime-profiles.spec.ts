import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildRuntimeConnectionProfile,
  RUNTIME_PROFILE_TEMPLATES,
  type RuntimeProfileTemplate,
} from "./runtime-profiles";
import { runCliProbe } from "../services/cli-probe";
import { parseConnectionProfile } from "./runtime-connection";

/** Deterministic fake CLI executables responding ONLY to the documented
 *  probe argv of each runtime. */
const makeFakeCli = (script: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-fake-cli-"));
  const file = path.join(dir, "fake-cli");
  fs.writeFileSync(file, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return file;
};

const FAKE_CODEX = makeFakeCli(`
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo "active mode: api_key"
  exit 0
fi
exit 9
`);
const FAKE_CODEX_LOGGED_OUT = makeFakeCli(`
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo "not logged in"
  exit 3
fi
exit 9
`);
const FAKE_CLAUDE = makeFakeCli(`
if [ "$1" = "--version" ]; then
  echo "2.1.228"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"authenticated":false}'
  exit 1
fi
exit 9
`);
const FAKE_OPENCODE = makeFakeCli(`
if [ "$1" = "--version" ]; then
  echo "1.18.16"
  exit 0
fi
exit 9
`);

describe("runtime profile templates (official sources, accessed 2026-08-12)", () => {
  it("every template records its official source and accessed date", () => {
    for (const template of Object.values(RUNTIME_PROFILE_TEMPLATES)) {
      expect(template.sourceUrl).toMatch(/^https:\/\//);
      expect(template.accessedAt).toBe("2026-08-12");
      expect(template.pinnedVersion).toMatch(/^[0-9]/);
    }
  });

  it("run argv uses documented flags only, never the unsupported surface", () => {
    const codex = RUNTIME_PROFILE_TEMPLATES.codex;
    expect(codex.runArgs).toEqual(["exec", "--json", "--ephemeral", "-"]);
    expect(codex.runArgs.join(" ")).not.toMatch(/full-auto|yolo|--version/);
    expect(codex.probe).toEqual({
      args: ["login", "status"],
      authAnyNonZero: true,
    });

    const claude = RUNTIME_PROFILE_TEMPLATES.claude;
    expect(claude.runArgs).toEqual(["-p", "--output-format", "json"]);
    expect(claude.probe).toEqual({ args: ["--version"], expectsVersion: true });
    expect(claude.authProbe).toEqual({
      args: ["auth", "status"],
      authExitCodes: [1],
    });

    const opencode = RUNTIME_PROFILE_TEMPLATES.opencode;
    expect(opencode.runArgs).toEqual(["run", "--format", "json"]);
    expect(opencode.probe).toEqual({
      args: ["--version"],
      expectsVersion: true,
    });
    expect(opencode.authProbe).toBeUndefined();
  });

  it("template capabilities are the conservative documented ceiling", () => {
    const codex = RUNTIME_PROFILE_TEMPLATES.codex;
    expect(Object.keys(codex.declaredCapabilities).sort()).toEqual([
      "invocation",
      "localProcessTermination",
      "progressEvents",
      "structuredResult",
    ]);
    // Cancellation is not documented for `codex exec`: absent = unsupported.
    expect(codex.declaredCapabilities.cancellation).toBeUndefined();
    expect(codex.unsupported.length).toBeGreaterThan(0);
  });

  // P2 recheck 2026-08-15 (current official docs): every runtime documents
  // a model override flag (`--model`) and an official runtime-owned login
  // command. The argv prefix is FIXED configuration; the model id is
  // appended as ONE bounded data element behind it.

  it("documents the fixed model-argument argv prefix per runtime", () => {
    for (const template of Object.values(RUNTIME_PROFILE_TEMPLATES)) {
      expect(template.modelArgvPrefix).toEqual(["--model"]);
    }
  });

  it("documents the official runtime-owned login command for the guided Sign-in UX", () => {
    expect(RUNTIME_PROFILE_TEMPLATES.codex.loginCommand).toBe("codex login");
    expect(RUNTIME_PROFILE_TEMPLATES.claude.loginCommand).toBe(
      "claude auth login",
    );
    expect(RUNTIME_PROFILE_TEMPLATES.opencode.loginCommand).toBe(
      "opencode auth login",
    );
  });
});

describe("buildRuntimeConnectionProfile", () => {
  it("builds a validated, version-pinned connection profile per runtime", () => {
    const codex = buildRuntimeConnectionProfile({
      runtimeKind: "codex",
      name: "Codex local",
      executorId: "local-host",
      executable: "/opt/codex/bin/codex",
    });
    const parsed = parseConnectionProfile(codex);
    expect(parsed.runtimeKind).toBe("codex");
    expect(parsed.version).toBe("0.147.0");
    expect(parsed.cli?.command).toBe("/opt/codex/bin/codex");
    expect(parsed.cli?.args).toEqual(["exec", "--json", "--ephemeral", "-"]);
    expect(parsed.cli?.probe).toEqual({
      args: ["login", "status"],
      authAnyNonZero: true,
    });
    expect(parsed.declaredCapabilities).toEqual(
      RUNTIME_PROFILE_TEMPLATES.codex.declaredCapabilities,
    );
    // Secret-free by construction.
    expect(JSON.stringify(parsed)).not.toContain("sk-");
  });

  it("operator overrides stay bounded and never widen the capability ceiling", () => {
    const claude = buildRuntimeConnectionProfile({
      runtimeKind: "claude",
      name: "Claude local",
      executorId: "local-host",
      executable: "/usr/local/bin/claude",
      version: "2.1.227",
      credentialRefs: [{ kind: "env", name: "ANTHROPIC_API_KEY" }],
    });
    expect(claude.version).toBe("2.1.227");
    expect(claude.credentialRefs).toEqual([
      { kind: "env", name: "ANTHROPIC_API_KEY" },
    ]);
    // An operator may only DOWNGRADE capabilities, never widen them.
    const downgraded = buildRuntimeConnectionProfile({
      runtimeKind: "opencode",
      name: "OpenCode",
      executorId: "local-host",
      executable: "/opt/homebrew/bin/opencode",
      declaredCapabilities: {
        invocation: { supported: true, source: "configured" },
      },
    });
    expect(downgraded.declaredCapabilities.structuredResult).toBeUndefined();
  });
});

describe("deterministic fake-CLI probes per runtime", () => {
  it("codex: `login status` reports auth without ever parsing output into a version", async () => {
    const template = RUNTIME_PROFILE_TEMPLATES.codex;
    const ok = await runCliProbe({
      command: FAKE_CODEX,
      args: template.runArgs,
      probe: template.probe,
    });
    expect(ok).toMatchObject({ ok: true, reasonCode: "none" });
    expect(ok).not.toHaveProperty("version");

    const loggedOut = await runCliProbe({
      command: FAKE_CODEX_LOGGED_OUT,
      args: template.runArgs,
      probe: template.probe,
    });
    // "exit with 0 when logged in" -> any non-zero exit is auth-required.
    expect(loggedOut).toMatchObject({ ok: false, reasonCode: "auth-required" });
    expect(JSON.stringify(loggedOut)).not.toContain("not logged in");
  });

  it("claude: `--version` detects the version; `auth status` exit 1 is auth-required", async () => {
    const template = RUNTIME_PROFILE_TEMPLATES.claude;
    const version = await runCliProbe({
      command: FAKE_CLAUDE,
      args: template.runArgs,
      probe: template.probe,
    });
    expect(version).toMatchObject({ ok: true, version: "2.1.228" });

    const auth = await runCliProbe({
      command: FAKE_CLAUDE,
      args: template.runArgs,
      probe: template.authProbe!,
    });
    // Documented: "exits with code 0 if logged in, 1 if not".
    expect(auth).toMatchObject({ ok: false, reasonCode: "auth-required" });
    // Auth output (JSON account state) never appears in the outcome.
    expect(JSON.stringify(auth)).not.toContain("authenticated");
  });

  it("opencode: `--version` detects the version; auth stays runtime-owned", async () => {
    const template = RUNTIME_PROFILE_TEMPLATES.opencode;
    const version = await runCliProbe({
      command: FAKE_OPENCODE,
      args: template.runArgs,
      probe: template.probe,
    });
    expect(version).toMatchObject({ ok: true, version: "1.18.16" });
    expect(template.authProbe).toBeUndefined();
    expect(template.credentialEnvRefs).toEqual([]);
  });
});

/**
 * Opt-in live gates: run the documented NON-BILLABLE probes against the
 * real installed CLIs. They run ONLY when TENVYR_LIVE_RUNTIME_GATES=1 AND
 * the binary is installed; explicit SKIP reason otherwise. These probes
 * never send prompts, never call models, and never inspect auth files —
 * they only read local version/auth state.
 */
const livePath = (name: string): string | null => {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
};

/** P2: installed-runtime gates are opt-in via exactly
 *  TENVYR_LIVE_RUNTIME_GATES=1; deterministic fake-CLI tests remain the
 *  default. CI opts in explicitly (see .github/workflows). */
const liveGatesEnabled = () => process.env.TENVYR_LIVE_RUNTIME_GATES === "1";

const describeLive = (
  name: "codex" | "claude" | "opencode",
  template: RuntimeProfileTemplate,
) => {
  const binary = livePath(name);
  const describeWith = liveGatesEnabled() && binary ? describe : describe.skip;
  describeWith(`live ${name} CLI (installed: ${binary ?? "none"})`, () => {
    const probe = async () =>
      runCliProbe(
        { command: binary!, args: template.runArgs, probe: template.probe },
        { ...process.env },
      );

    // Live CLI probes on real binaries can be slow under parallel load
    // (cold starts, update checks); the probe wall clock is bounded to 10s.
    const LIVE_TIMEOUT_MS = 30_000;

    it(
      "version/auth-status probe completes with a bounded, secret-free outcome",
      async () => {
        const outcome = await probe();
        const rendered = JSON.stringify(outcome);
        expect(rendered.length).toBeLessThan(1024);
        if (template.probe.expectsVersion) {
          // A real version probe must succeed and yield a version.
          expect(outcome.ok).toBe(true);
          expect(outcome).toMatchObject({ reasonCode: "none" });
          if (outcome.ok) expect(outcome.version).toMatch(/^[0-9]/);
        } else {
          // Codex login status: logged in OR auth-required — never a leak of
          // the auth output into the outcome.
          expect(["none", "auth-required"]).toContain(outcome.reasonCode);
          expect(outcome).not.toHaveProperty("version");
          expect(rendered).not.toContain("Logged in");
          expect(rendered).not.toContain("api_key");
        }
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "records the live detected version as evidence",
      async () => {
        const outcome = await probe();
        if (template.probe.expectsVersion && outcome.ok && outcome.version) {
          // Version formats differ across releases; the pin (${template.pinnedVersion})
          // is the version the profile was written against, the detected value
          // is evidence.
          expect(outcome.version).toMatch(/^v?\d+(\.\d+)+/);
          expect(outcome.version).not.toMatch(/[\s;]/);
        }
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "documented auth-status probe runs live with a bounded outcome",
      async () => {
        const authProbe = template.authProbe;
        if (!authProbe) return;
        const outcome = await runCliProbe(
          { command: binary!, args: template.runArgs, probe: authProbe },
          { ...process.env },
        );
        // Logged in (ok) or not (auth-required) — never a leak of auth output.
        expect(["none", "auth-required"]).toContain(outcome.reasonCode);
        expect(outcome).not.toHaveProperty("version");
        const rendered = JSON.stringify(outcome);
        expect(rendered).not.toMatch(/authenticated|account|email|token/i);
      },
      LIVE_TIMEOUT_MS,
    );
  });
};

describeLive("codex", RUNTIME_PROFILE_TEMPLATES.codex);
describeLive("claude", RUNTIME_PROFILE_TEMPLATES.claude);
describeLive("opencode", RUNTIME_PROFILE_TEMPLATES.opencode);
