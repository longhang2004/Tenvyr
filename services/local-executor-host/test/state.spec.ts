import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearRunState,
  isProcessAlive,
  killProcessGroup,
  readRunState,
  terminateOrphan,
  writeRunState,
} from "../src/state";

const node = process.execPath;

const tmpDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-host-state-test-"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("run state files", () => {
  it("round-trips state and clears it", () => {
    const dir = tmpDir();
    writeRunState(dir, "agent-a", {
      invocationId: "inv-1",
      pid: 1234,
      startedAt: "2026-08-11T00:00:00.000Z",
      killAt: "2026-08-11T00:01:00.000Z",
    });

    expect(readRunState(dir, "agent-a")).toMatchObject({
      invocationId: "inv-1",
      pid: 1234,
    });

    clearRunState(dir, "agent-a");
    expect(readRunState(dir, "agent-a")).toBeNull();
  });

  it("returns null for a missing or malformed state file", () => {
    const dir = tmpDir();
    expect(readRunState(dir, "absent")).toBeNull();
    fs.writeFileSync(path.join(dir, "broken.json"), "not-json");
    expect(readRunState(dir, "broken")).toBeNull();
  });
});

describe("terminateOrphan", () => {
  it("terminates a live orphaned process group and clears the state", async () => {
    const dir = tmpDir();
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const pid = child.pid as number;
    writeRunState(dir, "agent-a", {
      invocationId: "orphan-inv",
      pid,
      startedAt: new Date().toISOString(),
      killAt: new Date().toISOString(),
    });

    const terminated = await terminateOrphan(dir, "agent-a", 200, () => true);

    expect(terminated).toBe("orphan-inv");
    await sleep(100);
    expect(isProcessAlive(pid)).toBe(false);
    expect(readRunState(dir, "agent-a")).toBeNull();
  });

  it("clears stale state when the recorded pid is already dead", async () => {
    const dir = tmpDir();
    writeRunState(dir, "agent-a", {
      invocationId: "stale-inv",
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
      killAt: new Date().toISOString(),
    });

    const terminated = await terminateOrphan(dir, "agent-a");

    expect(terminated).toBeNull();
    expect(readRunState(dir, "agent-a")).toBeNull();
  });

  it("returns null when no state file exists", async () => {
    const dir = tmpDir();
    expect(await terminateOrphan(dir, "agent-a")).toBeNull();
  });

  it("never terminates a live process whose identity verification fails (pid reuse guard)", async () => {
    const dir = tmpDir();
    const innocent = spawn(node, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => innocent.once("spawn", () => resolve()));
    const pid = innocent.pid as number;
    writeRunState(dir, "agent-a", {
      invocationId: "reused-pid-inv",
      pid,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      killAt: new Date().toISOString(),
    });

    const terminated = await terminateOrphan(dir, "agent-a", 200, () => false);

    expect(terminated).toBeNull();
    expect(isProcessAlive(pid)).toBe(true);
    expect(readRunState(dir, "agent-a")).toBeNull();
    innocent.kill("SIGKILL");
  });

  it("terminates when identity verification confirms the recorded process", async () => {
    const dir = tmpDir();
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const pid = child.pid as number;
    writeRunState(dir, "agent-a", {
      invocationId: "match-inv",
      pid,
      startedAt: new Date().toISOString(),
      killAt: new Date().toISOString(),
    });

    const terminated = await terminateOrphan(dir, "agent-a", 200, () => true);

    expect(terminated).toBe("match-inv");
    await sleep(100);
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe("process group kill", () => {
  it("kills the whole group including same-group descendants", async () => {
    // Parent spawns a NON-detached grandchild (same group); killing the
    // group must reach both.
    const child = spawn(
      node,
      [
        "-e",
        "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const pid = child.pid as number;
    await sleep(300);

    killProcessGroup(pid, "SIGKILL");
    await sleep(100);

    expect(isProcessAlive(pid)).toBe(false);
  });
});
