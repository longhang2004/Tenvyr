#!/usr/bin/env node

/**
 * T07 Review Showcase Runner & Lifecycle Manager.
 *
 * Implements up | down | status:
 * - POSIX mode/symlink defense (WSL v9fs rejection).
 * - Real committed Git archive build context with verified 40-hex SHA.
 * - Atomic exclusive credentials & fail-closed persistent state recovery.
 * - Single-pass bootstrap with strict DB user inspection and multi-user authentication.
 * - Strict dual-label ownership guard before mutations and down.
 * - Cleanup restricted only to newly created containers with verified dual labels.
 * - Native Compose --wait health verification.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  mkdirSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
  chmodSync,
  mkdtempSync,
  renameSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "docker-compose.review.yml");
const PROJECT_NAME = "tenvyr-review";
const EXPECTED_CONTAINERS = [
  "tenvyr-review-postgres",
  "tenvyr-review-api",
  "tenvyr-review-worker",
];
const EXPECTED_VOLUME = "tenvyr_review_pgdata";

const verb = process.argv[2];
if (!verb || !["up", "down", "status"].includes(verb)) {
  process.stderr.write("Usage: review-showcase.sh up|down|status\n");
  process.exit(1);
}

// Port configuration validation (strict ASCII integer 1..65535, default 8080)
function parseAndValidatePort(raw) {
  if (raw === undefined || raw === null || raw === "") return 8080;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    process.stderr.write("Invalid TENVYR_REVIEW_PORT: must be a strict integer between 1 and 65535\n");
    process.exit(1);
  }
  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65535) {
    process.stderr.write("Invalid TENVYR_REVIEW_PORT: must be a strict integer between 1 and 65535\n");
    process.exit(1);
  }
  return port;
}

const reviewPort = parseAndValidatePort(process.env.TENVYR_REVIEW_PORT);

// 1. Resolve runtime directory
let runtimeDir = process.env.TENVYR_REVIEW_RUNTIME_DIR;
if (!runtimeDir || runtimeDir.trim() === "") {
  const home = homedir() || process.env.HOME || process.env.USERPROFILE || "/tmp";
  runtimeDir = join(home, ".tenvyr", "review-runtime");
}
runtimeDir = resolve(runtimeDir);

function sanitizeLog(text) {
  if (!text) return "";
  return text.replace(/[0-9a-f]{32,64}/gi, "[REDACTED]");
}

function validateAncestors(targetPath) {
  let curr = resolve(targetPath);
  const ancestors = [];
  while (true) {
    const parent = dirname(curr);
    if (parent === curr) break;
    ancestors.push(parent);
    curr = parent;
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const ancestor of ancestors) {
    let lstat;
    try {
      lstat = lstatSync(ancestor);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (lstat.isSymbolicLink()) {
      process.stderr.write("Security rejection: ancestor directory cannot be a symlink: " + ancestor + "\n");
      process.exit(1);
    }
    const stat = statSync(ancestor);
    if (!stat.isDirectory()) {
      process.stderr.write("Security rejection: ancestor path is not a directory: " + ancestor + "\n");
      process.exit(1);
    }
    if (currentUid !== null) {
      if (stat.uid !== currentUid && stat.uid !== 0) {
        process.stderr.write(
          "Security rejection: ancestor directory " +
            ancestor +
            " owned by uid " +
            stat.uid +
            ", expected current UID (" +
            currentUid +
            ") or root (0)\n"
        );
        process.exit(1);
      }
    }
    if ((stat.mode & 0o022) !== 0) {
      const isSticky = (stat.mode & 0o1000) !== 0;
      if (!isSticky) {
        process.stderr.write(
          "Security rejection: ancestor directory " +
            ancestor +
            " is group/world-writable without sticky bit: 0" +
            (stat.mode & 0o777).toString(8) +
            "\n"
        );
        process.exit(1);
      }
    }
  }
}

function validateSecureDir(dirPath, createIfMissing = true) {
  const resolved = resolve(dirPath);
  validateAncestors(resolved);

  let lstat = null;
  try {
    lstat = lstatSync(resolved);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;

  if (!lstat) {
    if (!createIfMissing) return false;
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    try { chmodSync(resolved, 0o700); } catch {}
    const freshStat = statSync(resolved);
    if ((freshStat.mode & 0o777) !== 0o700) {
      process.stderr.write(
        "Security rejection: runtime directory must be mode 0700, found: 0" +
          (freshStat.mode & 0o777).toString(8) +
          ". Insecure permissions or WSL v9fs mounts are rejected.\n"
      );
      process.exit(1);
    }
    if (currentUid !== null && freshStat.uid !== currentUid) {
      process.stderr.write(
        "Security rejection: runtime directory must be owned by current UID " +
          currentUid +
          ", found: " +
          freshStat.uid +
          "\n"
      );
      process.exit(1);
    }
    return true;
  }

  if (lstat.isSymbolicLink()) {
    process.stderr.write("Security rejection: runtime directory cannot be a symlink: " + resolved + "\n");
    process.exit(1);
  }

  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    process.stderr.write("Security rejection: runtime path is not a directory: " + resolved + "\n");
    process.exit(1);
  }

  if (currentUid !== null && stat.uid !== currentUid) {
    process.stderr.write(
      "Security rejection: runtime directory must be owned by current UID " +
        currentUid +
        ", found: " +
        stat.uid +
        "\n"
    );
    process.exit(1);
  }

  if ((stat.mode & 0o777) !== 0o700) {
    process.stderr.write(
      "Security rejection: runtime directory must be mode 0700, found: 0" +
        (stat.mode & 0o777).toString(8) +
        ". Insecure permissions or WSL v9fs mounts are rejected.\n"
    );
    process.exit(1);
  }

  return true;
}

function validateSecureFile(filePath) {
  let lstat;
  try {
    lstat = lstatSync(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }

  if (lstat.isSymbolicLink()) {
    process.stderr.write("Security rejection: credentials file cannot be a symlink: " + filePath + "\n");
    process.exit(1);
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    process.stderr.write("Security rejection: credentials path cannot be accessed: " + filePath + "\n");
    process.exit(1);
  }

  if (!stat.isFile()) {
    process.stderr.write("Security rejection: credentials path is not a regular file: " + filePath + "\n");
    process.exit(1);
  }

  if ((stat.mode & 0o777) !== 0o600) {
    process.stderr.write(
      "Security rejection: credentials file must be mode 0600, found: 0" +
        (stat.mode & 0o777).toString(8) +
        "\n"
    );
    process.exit(1);
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stat.uid !== currentUid) {
    process.stderr.write(
      "Security rejection: credentials file must be owned by current UID " +
        currentUid +
        ", found: " +
        stat.uid +
        "\n"
    );
    process.exit(1);
  }

  return true;
}

const bootstrapFile = join(runtimeDir, "bootstrap.json");
const credentialsFile = join(runtimeDir, "credentials.env");
const lockFile = join(runtimeDir, "launcher.lock");
const markerFile = join(runtimeDir, ".bootstrap-initialized");
const uuidProofFile = join(runtimeDir, "user-ids.json");

function runCommand(bin, args, options = {}) {
  const res = spawnSync(bin, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout || 60000,
  });
  return res;
}

function loadCredentialsEnv(failClosed = true) {
  const customEnv = {
    TENVYR_REVIEW_RUNTIME_DIR: runtimeDir,
    TENVYR_REVIEW_PORT: String(reviewPort),
  };
  let credLstat = null;
  try {
    credLstat = lstatSync(credentialsFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!credLstat) {
    if (failClosed) {
      process.stderr.write("Fail-closed error: credentials.env does not exist: " + credentialsFile + "\n");
      process.exit(1);
    }
    return customEnv;
  }

  validateSecureFile(credentialsFile);
  const content = readFileSync(credentialsFile, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      customEnv[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }

  if (failClosed) {
    const requiredKeys = [
      "TENVYR_REVIEW_DB_PASSWORD",
      "TENVYR_REVIEW_WORKER_BEARER_TOKEN",
      "TENVYR_REVIEW_CALLBACK_SECRET",
    ];
    for (const key of requiredKeys) {
      if (!customEnv[key] || customEnv[key].trim() === "") {
        process.stderr.write("Fail-closed error: credentials.env missing required key: " + key + "\n");
        process.exit(1);
      }
    }
  }
  return customEnv;
}

// Strict ownership verification: both labels must match tenvyr-review
function verifyStrictOwnership() {
  const psInv = runCommand("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (psInv.status !== 0) {
    process.stderr.write("Docker inventory check failed: " + sanitizeLog(psInv.stderr || "") + "\n");
    process.exit(1);
  }
  const existingNames = (psInv.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const name of EXPECTED_CONTAINERS) {
    if (existingNames.includes(name)) {
      const inspectRes = runCommand("docker", [
        "inspect",
        name,
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "io.tenvyr.review.owner"}}',
      ]);
      if (inspectRes.status !== 0 || !inspectRes.stdout) {
        process.stderr.write(`Foreign ownership conflict: container ${name} unreadable or inspect failed\n`);
        process.exit(1);
      }
      const [proj, owner] = inspectRes.stdout.trim().split("|");
      if (proj !== PROJECT_NAME || owner !== PROJECT_NAME) {
        process.stderr.write(`Foreign ownership conflict: container ${name} has project='${proj}', owner='${owner}'\n`);
        process.exit(1);
      }
    }
  }

  const volLs = runCommand("docker", ["volume", "ls", "--format", "{{.Name}}"]);
  if (volLs.status !== 0) {
    process.stderr.write("Docker inventory check failed: " + sanitizeLog(volLs.stderr || "") + "\n");
    process.exit(1);
  }
  if (volLs.stdout) {
    const existingVols = volLs.stdout.split("\n").map((s) => s.trim());
    if (existingVols.includes(EXPECTED_VOLUME)) {
      const volInspect = runCommand("docker", [
        "volume",
        "inspect",
        EXPECTED_VOLUME,
        "--format",
        '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "io.tenvyr.review.owner"}}',
      ]);
      if (volInspect.status !== 0 || !volInspect.stdout) {
        process.stderr.write(`Foreign ownership conflict: volume ${EXPECTED_VOLUME} inspect failed\n`);
        process.exit(1);
      }
      const [vProj, vOwner] = volInspect.stdout.trim().split("|");
      if (vProj !== PROJECT_NAME || vOwner !== PROJECT_NAME) {
        process.stderr.write(`Foreign ownership conflict: volume ${EXPECTED_VOLUME} has project='${vProj}', owner='${vOwner}'\n`);
        process.exit(1);
      }
    }
  }
}

// STATUS verb: must NOT create directories or files, must handle null status safely
if (verb === "status") {
  let runtimeLstat = null;
  try {
    runtimeLstat = lstatSync(runtimeDir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (runtimeLstat) {
    validateSecureDir(runtimeDir, false);
  }
  let credLstat = null;
  try {
    credLstat = lstatSync(credentialsFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (credLstat) {
    validateSecureFile(credentialsFile);
  }
  const statusEnv = credLstat ? loadCredentialsEnv(false) : { TENVYR_REVIEW_RUNTIME_DIR: runtimeDir, TENVYR_REVIEW_PORT: String(reviewPort) };
  const res = runCommand("docker", ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "ps"], { env: statusEnv });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(sanitizeLog(res.stderr));
  if (res.status === null || res.error) {
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

// Validate and create runtime directory for up and down verbs
validateSecureDir(runtimeDir, true);

// Stale-safe process locking
function acquireLock() {
  let lockLstat = null;
  try {
    lockLstat = lstatSync(lockFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  if (lockLstat) {
    validateSecureFile(lockFile);
    try {
      const raw = readFileSync(lockFile, "utf8");
      const lockData = JSON.parse(raw);
      if (lockData && lockData.pid) {
        try {
          process.kill(lockData.pid, 0);
          process.stderr.write("Concurrent launcher execution locked: " + lockFile + "\n");
          process.exit(1);
        } catch (err) {
          if (err.code === "ESRCH") {
            try { unlinkSync(lockFile); } catch {}
          } else {
            process.stderr.write("Concurrent launcher execution locked: " + lockFile + "\n");
            process.exit(1);
          }
        }
      }
    } catch (e) {
      if (e.message && e.message.startsWith("Concurrent launcher execution locked")) {
        throw e;
      }
      try { unlinkSync(lockFile); } catch {}
    }
  }

  let lockFd = null;
  try {
    lockFd = openSync(lockFile, "wx", 0o600);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { encoding: "utf8" });
  } catch (e) {
    if (e.code === "EEXIST") {
      process.stderr.write("Concurrent launcher execution locked: " + lockFile + "\n");
      process.exit(1);
    }
    throw e;
  }

  const releaseLock = () => {
    if (lockFd !== null) {
      try {
        closeSync(lockFd);
        unlinkSync(lockFile);
      } catch {}
      lockFd = null;
    }
  };

  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(1); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(1); });
  return releaseLock;
}

const releaseLock = acquireLock();

// DOWN verb: safe container removal without removing volumes or credentials
if (verb === "down") {
  verifyStrictOwnership();
  const downEnv = loadCredentialsEnv(false);
  const res = runCommand("docker", ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "down"], { env: downEnv });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(sanitizeLog(res.stderr));
  if (res.status === null || res.error) {
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

// --- UP VERB ---

// 1. Strict pre-mutation ownership verification
verifyStrictOwnership();

// 2. Fail-closed volume and credential state verification
const volLsCheck = runCommand("docker", ["volume", "ls", "--format", "{{.Name}}"]);
if (volLsCheck.status !== 0) {
  process.stderr.write("Docker inventory check failed: " + sanitizeLog(volLsCheck.stderr || "") + "\n");
  process.exit(1);
}
const existingVols = (volLsCheck.stdout || "").split("\n").map((s) => s.trim());
const volumeExists = existingVols.includes(EXPECTED_VOLUME);

let bootLstat = null;
try { bootLstat = lstatSync(bootstrapFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (bootLstat) validateSecureFile(bootstrapFile);

let credLstat = null;
try { credLstat = lstatSync(credentialsFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (credLstat) validateSecureFile(credentialsFile);

const hasBootstrap = !!bootLstat;
const hasCredentials = !!credLstat;

if (volumeExists && (!hasBootstrap || !hasCredentials)) {
  process.stderr.write(
    "Fail-closed error: Docker volume " + EXPECTED_VOLUME + " exists but runtime credentials are missing in " +
      runtimeDir +
      ". To prevent data loss or unauthenticated state, supply existing credentials or remove volume explicitly.\n"
  );
  process.exit(1);
}

if (!volumeExists && (hasBootstrap !== hasCredentials)) {
  process.stderr.write(
    "Fail-closed error: Incomplete credentials state detected in " +
      runtimeDir +
      ". Partial state must not be overwritten.\n"
  );
  process.exit(1);
}

// 3. Atomic credential generation if not present
if (!hasBootstrap && !hasCredentials) {
  const subAPass = randomBytes(16).toString("hex");
  const subBPass = randomBytes(16).toString("hex");
  const revPass = randomBytes(16).toString("hex");

  const dbPass = randomBytes(16).toString("hex");
  const workerBearer = randomBytes(24).toString("hex");
  const callbackSecret = randomBytes(32).toString("hex");

  const usersManifest = [
    { username: "submitter_a", password: subAPass, role: "SUBMITTER" },
    { username: "submitter_b", password: subBPass, role: "SUBMITTER" },
    { username: "reviewer", password: revPass, role: "REVIEWER" },
  ];

  const tmpBootstrap = join(runtimeDir, "bootstrap.tmp." + randomBytes(8).toString("hex"));
  writeFileSync(tmpBootstrap, JSON.stringify(usersManifest, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmpBootstrap, 0o600); } catch {}
  renameSync(tmpBootstrap, bootstrapFile);

  const envLines = [
    `TENVYR_REVIEW_DB_PASSWORD=${dbPass}`,
    `TENVYR_REVIEW_WORKER_BEARER_TOKEN=${workerBearer}`,
    `TENVYR_REVIEW_CALLBACK_SECRET=${callbackSecret}`,
  ];
  const tmpCredentials = join(runtimeDir, "credentials.tmp." + randomBytes(8).toString("hex"));
  writeFileSync(tmpCredentials, envLines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmpCredentials, 0o600); } catch {}
  renameSync(tmpCredentials, credentialsFile);
}

validateSecureFile(bootstrapFile);
validateSecureFile(credentialsFile);
const customEnv = loadCredentialsEnv(true);

// 4. Resolve exact 40-hex Git commit revision and create committed archive build context
let commitHash = process.env.SOURCE_REVISION;
if (!commitHash || !/^[0-9a-f]{40}$/i.test(commitHash.trim())) {
  const revRes = runCommand("git", ["rev-parse", "HEAD"]);
  if (revRes.status === 0 && revRes.stdout && /^[0-9a-f]{40}$/i.test(revRes.stdout.trim())) {
    commitHash = revRes.stdout.trim();
  }
}
if (!commitHash || !/^[0-9a-f]{40}$/i.test(commitHash.trim())) {
  process.stderr.write("Security rejection: unable to resolve verified 40-hex Git commit hash from HEAD.\n");
  process.exit(1);
}
commitHash = commitHash.trim();
customEnv["SOURCE_REVISION"] = commitHash;

const archiveContextDir = mkdtempSync(join(tmpdir(), "tenvyr-archive-"));
const cleanupArchive = () => {
  try {
    rmSync(archiveContextDir, { recursive: true, force: true });
  } catch {}
};
process.on("exit", cleanupArchive);

const gitArchive = spawnSync("git", ["archive", "--format=tar", commitHash], {
  cwd: ROOT,
  maxBuffer: 100 * 1024 * 1024,
});
if (gitArchive.status !== 0 || !gitArchive.stdout) {
  process.stderr.write("Failed to create Git archive from commit " + commitHash + "\n");
  process.exit(1);
}

const tarExtract = spawnSync("tar", ["-xf", "-", "-C", archiveContextDir], {
  input: gitArchive.stdout,
  timeout: 60000,
});
if (tarExtract.status !== 0) {
  process.stderr.write("Failed to extract committed Git archive into " + archiveContextDir + "\n");
  process.exit(1);
}

customEnv["TENVYR_REVIEW_BUILD_CONTEXT"] = archiveContextDir;

function getProjectContainerIds() {
  const res = runCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${PROJECT_NAME}`,
    "--format",
    "{{.ID}}",
  ]);
  if (res.status === 0 && res.stdout) {
    return res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

const priorContainerIds = getProjectContainerIds();

function cleanupNewlyCreatedContainers() {
  const currentIds = getProjectContainerIds();
  const toRemove = currentIds.filter((id) => !priorContainerIds.includes(id));
  for (const cid of toRemove) {
    const inspectRes = runCommand("docker", [
      "inspect",
      cid,
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "io.tenvyr.review.owner"}}',
    ]);
    if (inspectRes.status === 0 && inspectRes.stdout) {
      const [proj, owner] = inspectRes.stdout.trim().split("|");
      if (proj === PROJECT_NAME && owner === PROJECT_NAME) {
        runCommand("docker", ["rm", "-f", cid]);
      } else {
        process.stderr.write(`Cleanup incomplete: container ${cid} did not have verified dual labels\n`);
      }
    } else {
      process.stderr.write(`Cleanup incomplete: container ${cid} inspect failed\n`);
    }
  }
}

// 5. Build images from clean committed archive context
const buildRes = runCommand(
  "docker",
  ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "build"],
  { env: customEnv, timeout: 600000 }
);

if (buildRes.status !== 0) {
  process.stderr.write("docker compose build failed: " + sanitizeLog(buildRes.stderr || buildRes.stdout || "") + "\n");
  cleanupNewlyCreatedContainers();
  process.exit(buildRes.status ?? 1);
}

// 6. Start Postgres service first and inspect user state
const pgUpRes = runCommand(
  "docker",
  ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "up", "-d", "--wait", "--wait-timeout", "30", "postgres"],
  { env: customEnv, timeout: 60000 }
);

if (pgUpRes.status !== 0) {
  process.stderr.write("Database startup failed: " + sanitizeLog(pgUpRes.stderr || pgUpRes.stdout || "") + "\n");
  cleanupNewlyCreatedContainers();
  process.exit(pgUpRes.status ?? 1);
}

// Probe table existence explicitly via to_regclass
const tblProbeRes = runCommand(
  "docker",
  ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "tenvyr_review", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
  {
    env: customEnv,
    input: "SELECT to_regclass('tenvyr_review.users') IS NOT NULL;\n",
    timeout: 10000,
  }
);

if (tblProbeRes.status !== 0 || !tblProbeRes.stdout) {
  process.stderr.write("Fail-closed error: database table existence probe failed: " + sanitizeLog(tblProbeRes.stderr || "") + "\n");
  cleanupNewlyCreatedContainers();
  process.exit(1);
}

const tableExistsOutput = tblProbeRes.stdout.trim();
let needBootstrap = true;

if (tableExistsOutput === "t" || tableExistsOutput === "true") {
  const usersQueryRes = runCommand(
    "docker",
    ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "tenvyr_review", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|"],
    {
      env: customEnv,
      input: "SELECT username, role, enabled FROM tenvyr_review.users ORDER BY username;\n",
      timeout: 10000,
    }
  );

  if (usersQueryRes.status !== 0 || !usersQueryRes.stdout) {
    process.stderr.write("Fail-closed error: database user rows query failed: " + sanitizeLog(usersQueryRes.stderr || "") + "\n");
    cleanupNewlyCreatedContainers();
    process.exit(1);
  }

  const lines = usersQueryRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    needBootstrap = true;
  } else if (lines.length === 3) {
    const parsed = lines.map((l) => {
      const [u, r, e] = l.split("|");
      return { username: u, role: r, enabled: e === "t" || e === "true" };
    });
    const subA = parsed.find((p) => p.username === "submitter_a" && p.role === "SUBMITTER" && p.enabled);
    const subB = parsed.find((p) => p.username === "submitter_b" && p.role === "SUBMITTER" && p.enabled);
    const rev = parsed.find((p) => p.username === "reviewer" && p.role === "REVIEWER" && p.enabled);

    if (subA && subB && rev) {
      needBootstrap = false;
    } else {
      process.stderr.write("Fail-closed error: database contains conflicting user rows in tenvyr_review.users.\n");
      cleanupNewlyCreatedContainers();
      process.exit(1);
    }
  } else {
    process.stderr.write("Fail-closed error: database contains partial or conflicting user count: " + lines.length + "\n");
    cleanupNewlyCreatedContainers();
    process.exit(1);
  }
} else if (tableExistsOutput === "f" || tableExistsOutput === "false") {
  needBootstrap = true;
} else {
  process.stderr.write("Fail-closed error: unparseable database probe response: " + tableExistsOutput + "\n");
  cleanupNewlyCreatedContainers();
  process.exit(1);
}

if (needBootstrap) {
  customEnv["TENVYR_REVIEW_BOOTSTRAP_CONTAINER_PATH"] = "/run/secrets/bootstrap.json";
} else {
  customEnv["TENVYR_REVIEW_BOOTSTRAP_CONTAINER_PATH"] = "";
}

// 7. Start review-api and review-worker with native Compose --wait health check
const upRes = runCommand(
  "docker",
  ["compose", "-p", PROJECT_NAME, "-f", COMPOSE_FILE, "up", "-d", "--wait", "--wait-timeout", "90"],
  { env: customEnv, timeout: 120000 }
);

if (upRes.status !== 0) {
  process.stderr.write("docker compose up failed: " + sanitizeLog(upRes.stderr || upRes.stdout || "") + "\n");
  cleanupNewlyCreatedContainers();
  process.exit(upRes.status ?? 1);
}

// 8. Multi-user authentication verification with Map cookie jar
async function authenticateUser(baseUrl, username, password, expectedRole) {
  const cookieJar = new Map();
  const captureCookies = (res) => {
    const sc = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const raw of sc) {
      if (!raw) continue;
      const pair = raw.split(";")[0];
      const eqIdx = pair.indexOf("=");
      if (eqIdx !== -1) {
        cookieJar.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
      }
    }
  };
  const getCookieHeader = () => {
    return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  };

  const csrfRes = await fetch(`${baseUrl}/api/v1/auth/csrf`, {
    signal: AbortSignal.timeout(5000),
    redirect: "manual",
  });
  if (csrfRes.status !== 200) {
    throw new Error("CSRF token fetch returned HTTP " + csrfRes.status);
  }
  captureCookies(csrfRes);
  const csrf = await csrfRes.json();

  const body = new URLSearchParams({
    username,
    password,
    [csrf.parameterName]: csrf.token,
  });

  const loginRes = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      [csrf.headerName]: csrf.token,
      Cookie: getCookieHeader(),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(5000),
    redirect: "manual",
  });
  if (loginRes.status !== 204) {
    throw new Error("Login failed for " + username + ": HTTP " + loginRes.status);
  }
  captureCookies(loginRes);

  const meRes = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Cookie: getCookieHeader() },
    signal: AbortSignal.timeout(5000),
    redirect: "manual",
  });
  if (meRes.status !== 200) {
    throw new Error("Me endpoint failed for " + username + ": HTTP " + meRes.status);
  }
  const me = await meRes.json();
  if (me.username !== username) {
    throw new Error(`Username mismatch: expected ${username}, got ${me.username}`);
  }
  if (me.role !== expectedRole) {
    throw new Error(`Role mismatch for ${username}: expected ${expectedRole}, got ${me.role}`);
  }
  if (!me.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(me.id)) {
    throw new Error(`Invalid canonical UUID format for ${username}: ${me.id}`);
  }
  return me.id;
}

try {
  const rawUsers = JSON.parse(readFileSync(bootstrapFile, "utf8"));
  const authenticatedIds = {};
  for (const u of rawUsers) {
    const id = await authenticateUser(`http://127.0.0.1:${reviewPort}`, u.username, u.password, u.role);
    authenticatedIds[u.username] = id;
  }

  const distinctIds = new Set(Object.values(authenticatedIds));
  if (distinctIds.size !== 3) {
    throw new Error("Database assigned non-distinct user IDs: " + distinctIds.size);
  }

  // Cross-run UUID stability proof check
  let uuidLstat = null;
  try { uuidLstat = lstatSync(uuidProofFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (uuidLstat) {
    validateSecureFile(uuidProofFile);
    const prevProof = JSON.parse(readFileSync(uuidProofFile, "utf8"));
    for (const [uname, uid] of Object.entries(authenticatedIds)) {
      if (prevProof[uname] && prevProof[uname] !== uid) {
        throw new Error(`User ID changed across cycle for ${uname}: expected ${prevProof[uname]}, got ${uid}`);
      }
    }
  } else {
    let markerLstat = null;
    try { markerLstat = lstatSync(markerFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (markerLstat) {
      validateSecureFile(markerFile);
      const prevMarker = JSON.parse(readFileSync(markerFile, "utf8"));
      if (prevMarker.userIds) {
        for (const [uname, uid] of Object.entries(authenticatedIds)) {
          if (prevMarker.userIds[uname] && prevMarker.userIds[uname] !== uid) {
            throw new Error(`User ID changed across cycle for ${uname}: expected ${prevMarker.userIds[uname]}, got ${uid}`);
          }
        }
      }
    }
  }

  // Persist identity proofs atomically with mode 0600
  const tmpProof = join(runtimeDir, "user-ids.tmp." + randomBytes(8).toString("hex"));
  writeFileSync(tmpProof, JSON.stringify(authenticatedIds, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmpProof, 0o600); } catch {}
  renameSync(tmpProof, uuidProofFile);

  const tmpMarker = join(runtimeDir, "marker.tmp." + randomBytes(8).toString("hex"));
  writeFileSync(tmpMarker, JSON.stringify({ initializedAt: Date.now(), userIds: authenticatedIds }), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmpMarker, 0o600); } catch {}
  renameSync(tmpMarker, markerFile);
} catch (err) {
  process.stderr.write("User authentication verification failed: " + sanitizeLog(err.message) + "\n");
  cleanupNewlyCreatedContainers();
  process.exit(1);
}

process.stdout.write("Tenvyr Review Showcase running successfully on http://127.0.0.1:" + reviewPort + " (revision: " + commitHash + ")\n");
process.exit(0);
