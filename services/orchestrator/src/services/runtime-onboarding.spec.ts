import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeOnboardingService,
  isOnboardingRuntimeKind,
  resolveExecutableOnPath,
} from "./runtime-onboarding.service";

/**
 * Product Phase 1: guided runtime onboarding unit coverage with
 * DETERMINISTIC fake executables on a temp PATH (no real runtimes, no
 * credentials). Detection, version probing, auth probing, and the
 * not-detected path.
 */

function fakeExecutable(dir: string, name: string, stdout: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nprintf '%s\\n' "${stdout.replace(/"/g, '\\"')}"\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("runtime onboarding", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-onboarding-spec-"));
  const bin = join(dir, "bin");
  beforeAll(() => {
    mkdirSync(bin, { recursive: true });
  });
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("resolves an executable on PATH", () => {
    fakeExecutable(bin, "codex", "0.147.0");
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      expect(resolveExecutableOnPath("codex")).toBe(join(bin, "codex"));
      expect(resolveExecutableOnPath("definitely-not-installed")).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports NOT DETECTED with bounded guidance when the runtime is missing", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-path-for-onboarding";
    try {
      const status = await new RuntimeOnboardingService().status("claude");
      expect(status.detected).toBe(false);
      expect(status.executable).toBeNull();
      expect(status.connectPayload).toBeNull();
      expect(status.guidance.some((line) => line.includes("not found on PATH"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("detects + versions + auth-probes a fake Claude Code", async () => {
    fakeExecutable(bin, "claude", "2.1.228 (Claude Code)");
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const status = await new RuntimeOnboardingService().status("claude");
      expect(status.detected).toBe(true);
      expect(status.executable).toBe(join(bin, "claude"));
      expect(status.version).toBe("2.1.228");
      expect(status.authReady).toBe(true);
      expect(status.connectPayload).toEqual({
        runtimeKind: "claude",
        executable: join(bin, "claude"),
        version: "2.1.228",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("detects a fake Codex via its documented auth-status probe", async () => {
    fakeExecutable(bin, "codex", "auth status output");
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const status = await new RuntimeOnboardingService().status("codex");
      expect(status.detected).toBe(true);
      // Codex documents no version probe; the auth-status probe is the
      // primary probe and must NOT leak output into a version.
      expect(status.version).toBeNull();
      expect(status.authReady).toBe(true);
      expect(status.connectPayload?.executable).toBe(join(bin, "codex"));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("detects OpenCode without probing runtime-owned provider auth", async () => {
    fakeExecutable(bin, "opencode", "1.18.16");
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const status = await new RuntimeOnboardingService().status("opencode");
      expect(status.detected).toBe(true);
      expect(status.version).toBe("1.18.16");
      // Provider auth is runtime-owned: no auth probe exists and the
      // guidance says the connection test is the readiness check.
      expect(status.authReady).toBeNull();
      expect(status.guidance.some((line) => line.includes("runtime-owned"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects unsupported onboarding kinds", () => {
    expect(isOnboardingRuntimeKind("codex")).toBe(true);
    expect(isOnboardingRuntimeKind("claude")).toBe(true);
    expect(isOnboardingRuntimeKind("opencode")).toBe(true);
    expect(isOnboardingRuntimeKind("generic-cli")).toBe(false);
    expect(isOnboardingRuntimeKind("http-worker")).toBe(false);
  });
});
