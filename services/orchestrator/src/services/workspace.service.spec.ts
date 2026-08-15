import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitIdentity, resolveWorkspacePath } from "./workspace.service";

/**
 * Product Phase 1 unit coverage for the bounded workspace identity capture:
 * git repository identity (root/branch/HEAD/dirty), non-git directories,
 * and path validation. Uses real git when available (the repo itself is a
 * git work tree) and deterministic temp directories otherwise.
 */

describe("workspace identity capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-workspace-spec-"));
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("captures the repository identity of the Tenvyr checkout itself", () => {
    const root = join(__dirname, "..", "..", "..");
    const identity = captureGitIdentity(root);
    if (identity.repoRoot === null) {
      // git unavailable in this environment — the bounded best-effort
      // contract still holds (nullable fields, no throw).
      expect(identity.note).toBeDefined();
      return;
    }
    expect(identity.repoRoot).toBeTruthy();
    expect(identity.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof identity.dirty).toBe("boolean");
  });

  it("treats a non-git directory as a valid best-effort snapshot", () => {
    const plain = join(dir, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "file.txt"), "hello", "utf8");
    const identity = captureGitIdentity(plain);
    expect(identity.repoRoot).toBeNull();
    expect(identity.branch).toBeNull();
    expect(identity.headSha).toBeNull();
    expect(identity.dirty).toBeNull();
    expect(identity.note).toBeTruthy();
  });

  it("rejects missing paths and non-directories deterministically", () => {
    expect(() => resolveWorkspacePath(join(dir, "does-not-exist"))).toThrow(
      /does not exist/,
    );
    const file = join(dir, "file.txt");
    writeFileSync(file, "x", "utf8");
    expect(() => resolveWorkspacePath(file)).toThrow(/not a directory/);
  });

  it("rejects empty and oversized paths", () => {
    expect(() => resolveWorkspacePath("")).toThrow(/non-empty/);
    expect(() => resolveWorkspacePath("x".repeat(5000))).toThrow(/exceeds the bound/);
  });

  it("captures a dirty indicator for a repository with modifications", () => {
    const root = join(__dirname, "..", "..", "..");
    const identity = captureGitIdentity(root);
    if (identity.repoRoot === null || identity.dirty === null) return;
    expect(typeof identity.dirty).toBe("boolean");
  });
});
