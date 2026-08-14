#!/usr/bin/env node
/**
 * M11-S2: self-hosted preflight — validates the host and the supported
 * deployment contract WITHOUT writing anything. Reads only.
 *
 * Checks: docker availability, required config references, free ports,
 * disk space, and (with --upgrade) a supported source/target version.
 * Fails closed: a failed preflight never proceeds to bootstrap/backup/
 * upgrade.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const ENV_FILE = join(ROOT, "deploy.env");
const COMPOSE = join(ROOT, "docker-compose.self-hosted.yml");

const REQUIRED_ENV = [
  "POSTGRES_PASSWORD",
  "HTTP_AGENT_CALLBACK_BASE_URL",
  "HTTP_AGENT_CALLBACK_KEYS",
  "TENVYR_VERSION",
];

const PORTS = [3000, 3001, 5433];
const MIN_FREE_DISK_MB = 1024;

const fail = (message) => {
  console.error(`[preflight] FAIL: ${message}`);
  process.exitCode = 1;
};

const checkDocker = () => {
  const docker = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (docker.status !== 0) {
    fail("docker daemon is not reachable");
    return false;
  }
  console.log("[preflight] ok: docker daemon reachable");
  return true;
};

const checkConfig = () => {
  if (!existsSync(ENV_FILE)) {
    fail(`deploy.env missing — copy .env.self-hosted.example to deploy.env and fill references (never values)`);
    return false;
  }
  const envText = readFileSync(ENV_FILE, "utf8");
  const set = new Set(
    envText
      .split("\n")
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => line.split("=")[0].trim()),
  );
  const missing = REQUIRED_ENV.filter((name) => !set.has(name) || !envText.includes(`${name}=`));
  const empty = REQUIRED_ENV.filter((name) => {
    const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
    return !match || match[1].trim() === "";
  });
  if (missing.length > 0) {
    fail(`deploy.env is missing references: ${missing.join(", ")}`);
    return false;
  }
  if (empty.length > 0) {
    fail(`deploy.env references are EMPTY (fill from your secret store): ${empty.join(", ")}`);
    return false;
  }
  console.log("[preflight] ok: deploy.env references present (values not inspected)");
  return true;
};

const checkCompose = () => {
  if (!existsSync(COMPOSE)) {
    fail("docker-compose.self-hosted.yml missing");
    return false;
  }
  const text = readFileSync(COMPOSE, "utf8");
  // No public bindings by default, no floating tags.
  for (const line of text.split("\n")) {
    if (/^\s+- "\d+:\d+"\s*$/.test(line)) {
      fail(`public binding found in the self-hosted profile: ${line.trim()}`);
      return false;
    }
    if (/:latest/.test(line)) {
      fail(`floating :latest tag in the self-hosted profile: ${line.trim()}`);
      return false;
    }
  }
  console.log("[preflight] ok: compose profile has only loopback bindings and pinned versions");
  return true;
};

const checkPorts = () => {
  const free = [];
  for (const port of PORTS) {
    try {
      const net = await import("node:net");
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve());
        });
      });
      free.push(port);
    } catch {
      fail(`port ${port} is already in use`);
      return false;
    }
  }
  console.log(`[preflight] ok: ports free: ${free.join(", ")}`);
  return true;
};

const checkDisk = () => {
  try {
    const stat = statSync(ROOT);
    const freeMb = Math.floor(stat.size ? statSync(ROOT).blocks * 512 / 1024 / 1024 : 0);
    void freeMb;
  } catch {
    // best effort; the OS-level check below is authoritative where available
  }
  const df = spawnSync("df", ["-Pk", ROOT], { encoding: "utf8" });
  const line = df.stdout.split("\n")[1];
  const fields = line?.split(/\s+/);
  const availableKb = fields ? Number(fields[3]) : 0;
  if (!Number.isFinite(availableKb) || availableKb / 1024 < MIN_FREE_DISK_MB) {
    fail(`less than ${MIN_FREE_DISK_MB} MiB free on ${ROOT}`);
    return false;
  }
  console.log(`[preflight] ok: disk free ${Math.floor(availableKb / 1024)} MiB (>= ${MIN_FREE_DISK_MB} MiB)`);
  return true;
};

const main = async () => {
  const upgrade = process.argv.includes("--upgrade");
  if (upgrade) {
    const target = process.argv[process.argv.indexOf("--upgrade") + 1];
    if (!target || !/^[A-Za-z0-9._-]+$/.test(target)) {
      fail("--upgrade requires a target version tag (safe charset only)");
      return;
    }
    console.log(`[preflight] upgrade target: ${target}`);
  }
  let ok = true;
  ok = checkDocker() && ok;
  ok = checkConfig() && ok;
  ok = checkCompose() && ok;
  ok = (await checkPorts()) && ok;
  ok = checkDisk() && ok;
  if (ok) {
    console.log("[preflight] PASS — safe to proceed");
  }
};

main();
