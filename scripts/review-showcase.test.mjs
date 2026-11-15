/**
 * T07 Showcase and Launcher Contract Tests.
 *
 * Verifies Compose topology, Dockerfile source builds, launcher blackbox lifecycle
 * (up/down/status), WSL v9fs mode defense, fail-closed volume preservation,
 * container ownership cleanup, negative authentication verification, and smoke client contracts.
 *
 * Run with: node --test scripts/review-showcase.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  statSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_REVIEW = join(ROOT, "docker-compose.review.yml");
const LAUNCHER_SH = join(ROOT, "scripts", "review-showcase.sh");
const SMOKE_MJS = join(ROOT, "scripts", "review-smoke.mjs");
const API_DOCKERFILE = join(ROOT, "backend", "review-api", "Dockerfile");
const WORKER_DOCKERFILE = join(ROOT, "backend", "review-worker", "Dockerfile");
const APP_YML = join(ROOT, "backend", "review-api", "src", "main", "resources", "application.yml");

/**
 * Minimal stub Docker fixture for blackbox launcher testing.
 * Intercepts docker CLI invocations on PATH, maintains simulated state,
 * logs calls to STUB_DOCKER_LOG_FILE, and rejects unknown commands with non-zero exit.
 */
function createStubDockerHarness(parentTempDir, initialState = {}) {
  const binDir = join(parentTempDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(parentTempDir, "docker-cmds.log");
  const stateFile = join(parentTempDir, "docker-state.json");
  const preloadFile = join(binDir, "auth-preload.mjs");

  const state = {
    volumes: initialState.volumes || [],
    containers: initialState.containers || [],
    removedContainers: [],
    removedVolumes: [],
    buildContexts: [],
  };
  writeFileSync(stateFile, JSON.stringify(state), "utf8");

  // Preloader script for simulating CSRF/session login/me in launcher tests
  const preloadScript = `
const MOCK_IDS = {
  submitter_a: "00000000-0000-0000-0000-000000000001",
  submitter_b: "00000000-0000-0000-0000-000000000002",
  reviewer: "00000000-0000-0000-0000-000000000003",
};

globalThis.fetch = async function(url, options = {}) {
  const urlStr = String(url);
  const failMode = process.env.STUB_AUTH_FAIL; // "unreachable", "401", "wrong_role"
  if (failMode === "unreachable") {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    err.code = "ECONNREFUSED";
    throw err;
  }

  if (urlStr.includes("/api/v1/auth/csrf")) {
    return {
      status: 200,
      headers: new Headers({ "set-cookie": "JSESSIONID=csrf-token-session; Path=/" }),
      json: async () => ({ headerName: "X-CSRF-TOKEN", parameterName: "_csrf", token: "mock-csrf-token" }),
    };
  }

  if (urlStr.includes("/login")) {
    if (failMode === "401") {
      return { status: 401, headers: new Headers() };
    }
    const bodyStr = String(options.body || "");
    const params = new URLSearchParams(bodyStr);
    const username = params.get("username") || "user";
    return {
      status: 204,
      headers: new Headers({ "set-cookie": "JSESSIONID=sess-auth-" + username + "; Path=/" }),
    };
  }

  if (urlStr.includes("/api/v1/me")) {
    const cookieHeader = (options.headers && options.headers.Cookie) || "";
    let username = "submitter_a";
    if (cookieHeader.includes("submitter_b")) username = "submitter_b";
    else if (cookieHeader.includes("reviewer")) username = "reviewer";

    let role = username === "reviewer" ? "REVIEWER" : "SUBMITTER";
    if (failMode === "wrong_role") {
      role = "UNSUPPORTED_ROLE";
    }

    return {
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: MOCK_IDS[username] || "00000000-0000-0000-0000-000000000099",
        username,
        role,
      }),
    };
  }

  throw new Error("Unhandled test fetch: " + urlStr);
};
`;
  writeFileSync(preloadFile, preloadScript, "utf8");

  const stubScript = `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const logFile = process.env.STUB_DOCKER_LOG_FILE;
const stateFile = process.env.STUB_DOCKER_STATE_FILE;

if (logFile) {
  appendFileSync(logFile, JSON.stringify({ ts: Date.now(), args }) + "\\n");
}

let state = { volumes: [], containers: [], removedContainers: [], removedVolumes: [], buildContexts: [] };
if (stateFile) {
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
}

const saveState = () => {
  if (stateFile) {
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
  }
};

const failHealth = process.env.STUB_DOCKER_FAIL_HEALTH === "1";
const foreignConflict = process.env.STUB_DOCKER_FOREIGN_CONFLICT === "1";

// 1. Docker version / info
if (args[0] === "version" || args[0] === "--version" || (args[0] === "compose" && (args[1] === "version" || args[1] === "--version"))) {
  process.stdout.write("Docker Compose version v2.20.0\\n");
  process.exit(0);
}

// 2. Docker inspect commands
if (args[0] === "inspect") {
  let format = null;
  const operands = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--format" || a === "-f") {
      format = args[++i] ?? "";
    } else if (a.startsWith("--format=")) {
      format = a.slice("--format=".length);
    } else if (a.startsWith("-f=")) {
      format = a.slice("-f=".length);
    } else if (a === "--type") {
      i++;
    } else if (a.startsWith("--type=")) {
      // skip
    } else if (a.startsWith("-")) {
      // flag
    } else {
      operands.push(a);
    }
  }

  if (operands.length === 0) {
    process.stderr.write("docker inspect requires at least 1 object\\n");
    process.exit(1);
  }

  const target = operands[0];

  if (foreignConflict) {
    if (format !== null) {
      process.stdout.write("foreign-system|foreign-system\\n");
    } else {
      process.stdout.write(JSON.stringify([{ Config: { Labels: { "com.docker.compose.project": "foreign-system", "io.tenvyr.review.owner": "foreign-system" } } }]) + "\\n");
    }
    process.exit(0);
  }

  const found = state.containers.find(c => c.name === target || c.id === target);
  if (found) {
    const proj = found.project || "tenvyr-review";
    const owner = found.owned ? "tenvyr-review" : "foreign-system";
    if (format !== null) {
      process.stdout.write(proj + "|" + owner + "\\n");
    } else {
      process.stdout.write(JSON.stringify([{ Id: found.id || found.name, Config: { Labels: { "com.docker.compose.project": proj, "io.tenvyr.review.owner": owner } } }]) + "\\n");
    }
    process.exit(0);
  }
  process.stderr.write("No such object: " + target + "\\n");
  process.exit(1);
}

// 3. Docker container ps / rm commands
if (args[0] === "ps") {
  if (foreignConflict) {
    process.stdout.write("tenvyr-review-postgres\\n");
    process.exit(0);
  }
  const filterArg = args.find(a => a.includes("com.docker.compose.project="));
  const filterProject = filterArg ? filterArg.split("=").pop() : null;
  const list = filterProject ? state.containers.filter(c => c.project === filterProject) : state.containers;
  for (const c of list) {
    if (args.includes("--format") && args.includes("Names")) {
      process.stdout.write(c.name + "\\n");
    } else if (args.includes("--format")) {
      process.stdout.write(c.id + "\\n");
    } else {
      process.stdout.write(c.id + "   " + c.name + "   running\\n");
    }
  }
  process.exit(0);
}

if (args[0] === "rm") {
  const flagIdx = args.findIndex(a => !a.startsWith("-") && a !== "rm");
  const targetId = flagIdx !== -1 ? args[flagIdx] : args[args.length - 1];
  state.removedContainers.push(targetId);
  state.containers = state.containers.filter(c => c.id !== targetId);
  saveState();
  process.stdout.write(targetId + "\\n");
  process.exit(0);
}

// 4. Docker volume commands
if (args[0] === "volume") {
  const sub = args[1];
  if (sub === "ls") {
    process.stdout.write("DRIVER    VOLUME NAME\\n");
    for (const v of state.volumes) {
      if (args.includes("--format")) {
        process.stdout.write(v + "\\n");
      } else {
        process.stdout.write("local     " + v + "\\n");
      }
    }
    process.exit(0);
  }
  if (sub === "inspect") {
    let format = null;
    const operands = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === "--format" || a === "-f") {
        format = args[++i] ?? "";
      } else if (a.startsWith("--format=")) {
        format = a.slice("--format=".length);
      } else if (a.startsWith("-f=")) {
        format = a.slice("-f=".length);
      } else if (a.startsWith("-")) {
        // skip flag
      } else {
        operands.push(a);
      }
    }

    if (operands.length === 0) {
      process.stderr.write("docker volume inspect requires at least 1 volume name\\n");
      process.exit(1);
    }

    const vol = operands[0];

    if (foreignConflict) {
      if (format !== null) {
        process.stdout.write("foreign-system|foreign-system\\n");
      } else {
        process.stdout.write(JSON.stringify([{ Name: vol, Driver: "local", Labels: { "io.tenvyr.review.owner": "foreign-system", "com.docker.compose.project": "foreign-system" } }]) + "\\n");
      }
      process.exit(0);
    }

    if (state.volumes.includes(vol)) {
      if (format !== null) {
        process.stdout.write("tenvyr-review|tenvyr-review\\n");
      } else {
        process.stdout.write(JSON.stringify([{ Name: vol, Driver: "local", Labels: { "io.tenvyr.review.owner": "tenvyr-review", "com.docker.compose.project": "tenvyr-review" } }]) + "\\n");
      }
      process.exit(0);
    }
    process.stderr.write("No such volume: " + vol + "\\n");
    process.exit(1);
  }
  if (sub === "rm") {
    const vol = args[args.length - 1];
    state.removedVolumes.push(vol);
    state.volumes = state.volumes.filter(v => v !== vol);
    saveState();
    process.stdout.write(vol + "\\n");
    process.exit(0);
  }
  process.stderr.write("Unknown docker volume command: " + args.join(" ") + "\\n");
  process.exit(1);
}

// 5. Docker build
if (args[0] === "build") {
  const contextDir = process.env.TENVYR_REVIEW_BUILD_CONTEXT || args[args.length - 1];
  let committedContent = null;
  try {
    committedContent = readFileSync(join(contextDir, "committed.txt"), "utf8");
  } catch {}
  let targetExists = false;
  try {
    targetExists = existsSync(join(contextDir, "target"));
  } catch {}
  state.buildContexts.push({
    args,
    contextDir,
    committedContent,
    targetExists,
    revision: process.env.SOURCE_REVISION || "",
  });
  saveState();
  process.stdout.write("Successfully built mock-image\\n");
  process.exit(0);
}

// 6. Docker compose commands
if (args[0] === "compose") {
  let idx = 1;
  while (idx < args.length && args[idx].startsWith("-")) {
    if (["-p", "-f", "--project-name", "--file", "--env-file", "--project-directory"].includes(args[idx])) {
      idx += 2;
    } else {
      idx += 1;
    }
  }

  const verb = args[idx];
  const verbArgs = args.slice(idx + 1);

  if (verb === "config") {
    process.stdout.write("name: tenvyr-review\\nservices:\\n  review-api:\\n    image: review-api\\n");
    process.exit(0);
  }

  if (verb === "build") {
    const contextDir = process.env.TENVYR_REVIEW_BUILD_CONTEXT || process.cwd();
    let committedContent = null;
    try {
      committedContent = readFileSync(join(contextDir, "committed.txt"), "utf8");
    } catch {}
    let targetExists = false;
    try {
      targetExists = existsSync(join(contextDir, "target"));
    } catch {}
    state.buildContexts.push({
      args,
      contextDir,
      committedContent,
      targetExists,
      revision: process.env.SOURCE_REVISION || "",
    });
    saveState();
    process.stdout.write("[+] Building 2/2\\n");
    process.exit(0);
  }

  if (verb === "ps") {
    if (failHealth) {
      process.stdout.write("NAME                IMAGE               COMMAND             SERVICE             STATUS              PORTS\\n");
      process.stdout.write("review-api-1        review-api          \\"entrypoint\\"       review-api          unhealthy (1)       127.0.0.1:8080->8080/tcp\\n");
      process.exit(0);
    }
    process.stdout.write("NAME                IMAGE               COMMAND             SERVICE             STATUS              PORTS\\n");
    process.stdout.write("review-api-1        review-api          \\"entrypoint\\"       review-api          running (healthy)   127.0.0.1:8080->8080/tcp\\n");
    process.exit(0);
  }

  if (verb === "up") {
    if (foreignConflict) {
      process.stderr.write("Error: port or container name conflict with existing foreign project\\n");
      process.exit(1);
    }

    if (verbArgs.includes("postgres")) {
      if (!state.volumes.includes("tenvyr_review_pgdata")) {
        state.volumes.push("tenvyr_review_pgdata");
      }
      if (!state.containers.some(c => c.name === "tenvyr-review-postgres")) {
        state.containers.push({ id: "c_new_db", project: "tenvyr-review", name: "tenvyr-review-postgres", owned: true, createdThisRun: true });
      }
      saveState();
      process.stdout.write("[+] Running 1/1\\n ✔ Container tenvyr-review-postgres Healthy\\n");
      process.exit(0);
    }

    if (failHealth) {
      state.containers.push({ id: "c_new_api", project: "tenvyr-review", name: "tenvyr-review-api", owned: true, createdThisRun: true });
      saveState();
      process.stderr.write("Error response from daemon: container failed health check\\n");
      process.exit(1);
    }

    if (!state.containers.some(c => c.name === "tenvyr-review-postgres")) {
      state.containers.push({ id: "c_new_db", project: "tenvyr-review", name: "tenvyr-review-postgres", owned: true, createdThisRun: true });
    }
    if (!state.containers.some(c => c.name === "tenvyr-review-api")) {
      state.containers.push({ id: "c_new_api", project: "tenvyr-review", name: "tenvyr-review-api", owned: true, createdThisRun: true });
    }
    if (!state.containers.some(c => c.name === "tenvyr-review-worker")) {
      state.containers.push({ id: "c_new_worker", project: "tenvyr-review", name: "tenvyr-review-worker", owned: true, createdThisRun: true });
    }
    if (!state.volumes.includes("tenvyr_review_pgdata")) {
      state.volumes.push("tenvyr_review_pgdata");
    }

    const contextDir = process.env.TENVYR_REVIEW_BUILD_CONTEXT || process.cwd();
    let committedContent = null;
    try {
      committedContent = readFileSync(join(contextDir, "committed.txt"), "utf8");
    } catch {}
    let targetExists = false;
    try {
      targetExists = existsSync(join(contextDir, "target"));
    } catch {}
    state.buildContexts.push({
      args,
      contextDir,
      committedContent,
      targetExists,
      revision: process.env.SOURCE_REVISION || "",
    });
    saveState();
    process.stdout.write("[+] Running 3/3\\n ✔ Container tenvyr-review-postgres Healthy\\n ✔ Container tenvyr-review-api Healthy\\n ✔ Container tenvyr-review-worker Healthy\\n");
    process.exit(0);
  }

  if (verb === "down") {
    const hasVolumeFlag = verbArgs.some(a => a === "-v" || a === "--volumes");
    if (hasVolumeFlag) {
      state.removedVolumes.push("tenvyr_review_pgdata");
      state.volumes = state.volumes.filter(v => v !== "tenvyr_review_pgdata");
    }
    const toRemove = state.containers.filter(c => c.project === "tenvyr-review");
    for (const c of toRemove) {
      state.removedContainers.push(c.id);
    }
    state.containers = state.containers.filter(c => c.project !== "tenvyr-review");
    saveState();
    process.stdout.write("[+] Running 3/3\\n ✔ Container review-worker Removed\\n ✔ Container review-api    Removed\\n ✔ Container postgres      Removed\\n");
    process.exit(0);
  }

  if (verb === "exec") {
    // Read input from stdin if piped
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {}

    if (input.includes("to_regclass")) {
      if (state.containers.some(c => c.name === "tenvyr-review-api")) {
        process.stdout.write("t\\n");
      } else {
        process.stdout.write("f\\n");
      }
      process.exit(0);
    }

    if (input.includes("SELECT username")) {
      if (state.containers.some(c => c.name === "tenvyr-review-api")) {
        process.stdout.write("reviewer|REVIEWER|t\\nsubmitter_a|SUBMITTER|t\\nsubmitter_b|SUBMITTER|t\\n");
      } else {
        process.stdout.write("\\n");
      }
      process.exit(0);
    }

    process.stdout.write("t\\n");
    process.exit(0);
  }

  process.stderr.write("Unknown compose subcommand: " + verb + "\\n");
  process.exit(1);
}

// 7. Unknown command -> explicitly reject with non-zero exit code
process.stderr.write("Unknown docker command: " + args.join(" ") + "\\n");
process.exit(1);
`;

  writeFileSync(join(binDir, "docker-stub.mjs"), stubScript, "utf8");

  // POSIX shell wrapper for WSL Bash
  const shWrapper = `#!/bin/sh\nexec node "$(dirname "$0")/docker-stub.mjs" "$@"\n`;
  const shPath = join(binDir, "docker");
  writeFileSync(shPath, shWrapper, { encoding: "utf8", mode: 0o755 });
  try {
    chmodSync(shPath, 0o755);
  } catch {}

  return { binDir, logFile, stateFile, preloadFile };
}

function readDockerLog(logFile) {
  if (!existsSync(logFile)) return [];
  const content = readFileSync(logFile, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function safeStderr(stderr) {
  if (!stderr) return "";
  return stderr
    .split("\n")
    .map((line) => {
      if (/password|secret|token|bearer|cookie|authorization/i.test(line)) {
        return "[REDACTED_CREDENTIAL_LINE]";
      }
      return line.replace(/[0-9a-f]{16,64}/gi, "[REDACTED]");
    })
    .join("\n")
    .slice(0, 500);
}

function runLauncher(verb, options = {}) {
  const launcherPath = options.cwd
    ? join(options.cwd, "scripts", "review-showcase.sh")
    : LAUNCHER_SH;

  assert.ok(
    existsSync(launcherPath),
    `Launcher script scripts/review-showcase.sh must exist at ${launcherPath}`
  );

  const preloadUrl = options.preloadFile ? pathToFileURL(options.preloadFile).href : "";
  const nodeOptions = options.skipAuthPreload
    ? (options.env?.NODE_OPTIONS || "")
    : [options.env?.NODE_OPTIONS, preloadUrl ? `--import ${preloadUrl}` : ""].filter(Boolean).join(" ");

  const env = {
    ...process.env,
    PATH: options.binDir ? `${options.binDir}${delimiter}${process.env.PATH || ""}` : process.env.PATH,
    TENVYR_REVIEW_RUNTIME_DIR: options.runtimeDir || "",
    STUB_DOCKER_LOG_FILE: options.logFile || "",
    STUB_DOCKER_STATE_FILE: options.stateFile || "",
    ...options.env,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
  };

  const args = [launcherPath];
  if (verb) {
    args.push(verb);
  }

  const res = spawnSync("sh", args, {
    cwd: options.cwd || ROOT,
    env,
    encoding: "utf8",
    timeout: 15000,
  });

  if (res.error) {
    throw res.error;
  }
  if (res.status === null) {
    const boundOut = (res.stdout || "").slice(0, 500);
    const boundErr = (res.stderr || "").slice(0, 500);
    assert.fail(`Process timed out or killed with signal ${res.signal}. stdout: ${boundOut}, stderr: ${boundErr}`);
  }
  return res;
}

describe("T07 Showcase Compose Contract (SPEC & VERIFY)", () => {
  test("docker-compose.review.yml exists and declares project tenvyr-review and volume tenvyr_review_pgdata", () => {
    assert.ok(existsSync(COMPOSE_REVIEW), "docker-compose.review.yml must exist at repo root");
    const content = readFileSync(COMPOSE_REVIEW, "utf8");
    const hasProjectName = /name:\s*['"]?tenvyr-review['"]?/.test(content) || content.includes("tenvyr-review");
    assert.ok(hasProjectName, "Compose file must identify project as tenvyr-review");
    assert.match(content, /tenvyr_review_pgdata:/, "Dedicated volume tenvyr_review_pgdata must be declared");
  });

  test("topology is strictly API + Worker + PostgreSQL (no Kafka, Gateway, frontend, Node backend)", () => {
    assert.ok(existsSync(COMPOSE_REVIEW), "docker-compose.review.yml must exist");
    const content = readFileSync(COMPOSE_REVIEW, "utf8");

    assert.match(content, /(?:services:\s*[\s\S]*?)review-api:/, "review-api service must be defined");
    assert.match(content, /(?:services:\s*[\s\S]*?)review-worker:/, "review-worker service must be defined");
    assert.match(content, /(?:services:\s*[\s\S]*?)(?:postgres|db):/, "postgres service must be defined");

    assert.doesNotMatch(content, /\bkafka:/i, "Kafka is forbidden in review showcase topology");
    assert.doesNotMatch(content, /\bzookeeper:/i, "Zookeeper is forbidden in review showcase topology");
    assert.doesNotMatch(content, /\bgateway:/i, "Legacy gateway service is forbidden in review showcase topology");
    assert.doesNotMatch(content, /\borchestrator:/i, "Legacy orchestrator service is forbidden in review showcase topology");
    assert.doesNotMatch(content, /\bfrontend:/i, "Frontend service is forbidden in HTTP-only review showcase");
    assert.doesNotMatch(content, /\bnode-backend:/i, "Node backend is forbidden in review showcase topology");
  });

  test("port exposure: precise service scopes (loopback API published, Worker and DB unpublished)", () => {
    assert.ok(existsSync(COMPOSE_REVIEW), "docker-compose.review.yml must exist");
    const content = readFileSync(COMPOSE_REVIEW, "utf8");

    const lines = content.split("\n");
    const servicePorts = {};
    let currentService = null;
    let inPortsBlock = false;

    for (const line of lines) {
      const serviceMatch = line.match(/^(\s{2})([a-zA-Z0-9_-]+):\s*$/);
      if (serviceMatch) {
        currentService = serviceMatch[2];
        servicePorts[currentService] = [];
        inPortsBlock = false;
        continue;
      }

      if (currentService) {
        if (/^\s+ports:\s*$/.test(line)) {
          inPortsBlock = true;
          continue;
        }

        const propMatch = line.match(/^(\s+)[a-zA-Z0-9_-]+:\s*/);
        if (propMatch && !/^\s+ports:\s*$/.test(line) && !/^\s*-\s+/.test(line)) {
          inPortsBlock = false;
        }

        if (inPortsBlock) {
          const portItemMatch = line.match(/^\s+-\s+["']?([^"']+)["']?\s*$/);
          if (portItemMatch) {
            servicePorts[currentService].push(portItemMatch[1].trim());
          }
        }
      }
    }

    const apiPorts = servicePorts["review-api"] || [];
    assert.ok(
      apiPorts.some((p) => p.startsWith("127.0.0.1:8080:8080") || p === "127.0.0.1:8080:8080"),
      `review-api must publish loopback port 127.0.0.1:8080:8080, found: ${apiPorts.join(", ")}`
    );

    const workerPorts = servicePorts["review-worker"] || [];
    assert.equal(workerPorts.length, 0, `review-worker must NOT publish host ports, found: ${workerPorts.join(", ")}`);

    const dbPorts = servicePorts["postgres"] || servicePorts["db"] || [];
    assert.equal(dbPorts.length, 0, `PostgreSQL must NOT publish host ports, found: ${dbPorts.join(", ")}`);

    assert.doesNotMatch(content, /0\.0\.0\.0:\d+/, "Wildcard 0.0.0.0 host port publication is strictly forbidden");
  });

  test("Dockerfiles build from immutable committed source revision, independent of developer target dirs", () => {
    assert.ok(existsSync(API_DOCKERFILE), "backend/review-api/Dockerfile must exist");
    assert.ok(existsSync(WORKER_DOCKERFILE), "backend/review-worker/Dockerfile must exist");

    const apiDocker = readFileSync(API_DOCKERFILE, "utf8");
    const workerDocker = readFileSync(WORKER_DOCKERFILE, "utf8");

    assert.doesNotMatch(apiDocker, /COPY\s+target\//, "review-api Dockerfile must not copy developer target directory");
    assert.doesNotMatch(workerDocker, /COPY\s+target\//, "review-worker Dockerfile must not copy developer target directory");

    const hasRevisionProof =
      /ARG\s+(?:SOURCE_REVISION|REVISION|GIT_COMMIT)/.test(apiDocker) ||
      /LABEL\s+.*revision/.test(apiDocker);
    assert.ok(hasRevisionProof, "Dockerfiles must declare revision build-arg or label for auditability");
  });
});

describe("T07 Launcher Shell Blackbox Lifecycle (scripts/review-showcase.sh)", () => {
  test("launcher script review-showcase.sh exists and is executable", () => {
    assert.ok(existsSync(LAUNCHER_SH), `Launcher script must exist at ${LAUNCHER_SH}`);
    const content = readFileSync(LAUNCHER_SH, "utf8");
    assert.match(content, /^#!\/(?:usr\/)?bin\/(?:sh|bash)/, "Launcher must have standard POSIX shebang");
  });

  test("unknown subcommand exits non-zero and docker stub rejects unknown command with non-zero exit", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-unknown-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      const res = runLauncher("invalid-subcommand", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.notEqual(res.status, 0, "Unknown subcommand must exit non-zero");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("status subcommand is safe, non-mutating, and does not print credentials", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-status-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      const res = runLauncher("status", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.equal(res.status, 0, "status subcommand must exit 0");
      assert.doesNotMatch(res.stdout, /password|secret|token/i, "status must never print credentials");
      assert.doesNotMatch(res.stderr, /password|secret|token/i, "status must never print credentials to stderr");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("WSL v9fs security defense: rejects group-readable/world-readable runtime directory and symlinks", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-perm-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const insecureRuntimeDir = join(tempDir, "insecure-runtime");
      mkdirSync(insecureRuntimeDir, { mode: 0o755 });

      const resPerm = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir: insecureRuntimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.notEqual(resPerm.status, 0, "Launcher must reject insecure group/world-accessible runtime directory");
      assert.match(
        resPerm.stderr + resPerm.stdout,
        /(?:permission|secure|mode|0700|0600|restricted)/i,
        "Launcher must report security rejection for insecure runtime path"
      );

      // Symlink test
      const targetDir = join(tempDir, "real-target");
      mkdirSync(targetDir, { mode: 0o700 });
      const symlinkDir = join(tempDir, "symlinked-runtime");

      try {
        symlinkSync(targetDir, symlinkDir, "dir");
        const resSymlink = runLauncher("up", {
          binDir: harness.binDir,
          preloadFile: harness.preloadFile,
          runtimeDir: symlinkDir,
          logFile: harness.logFile,
          stateFile: harness.stateFile,
        });
        assert.notEqual(resSymlink.status, 0, "Launcher must reject symlinked runtime directory");
      } catch (e) {
        if (e.code !== "EPERM") throw e;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("security defense: rejects runtime directory with symlinked ancestor path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-ancsym-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const realParent = join(tempDir, "real-parent");
      mkdirSync(realParent, { mode: 0o700 });
      const symlinkParent = join(tempDir, "symlink-parent");

      try {
        symlinkSync(realParent, symlinkParent, "dir");
        const runtimeDir = join(symlinkParent, "runtime");
        mkdirSync(runtimeDir, { mode: 0o700 });

        const res = runLauncher("up", {
          binDir: harness.binDir,
          preloadFile: harness.preloadFile,
          runtimeDir,
          logFile: harness.logFile,
          stateFile: harness.stateFile,
        });
        assert.notEqual(res.status, 0, "Launcher must reject runtime directory with symlinked ancestor path");
        assert.match(
          res.stderr + res.stdout,
          /(?:permission|secure|mode|0700|0600|restricted|symlink)/i,
          "Launcher must report security rejection for ancestor symlink"
        );
      } catch (e) {
        if (e.code !== "EPERM") throw e;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("security defense: rejects runtime directory with non-sticky mode 0777 parent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-nonsticky-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const worldParent = join(tempDir, "world-parent");
      mkdirSync(worldParent, { mode: 0o777 });
      try {
        chmodSync(worldParent, 0o777);
      } catch {}

      const runtimeDir = join(worldParent, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      const res = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.notEqual(res.status, 0, "Launcher must reject runtime directory under non-sticky mode 0777 parent");
      assert.match(
        res.stderr + res.stdout,
        /(?:permission|secure|mode|0700|0600|restricted|sticky|parent)/i,
        "Launcher must report security rejection for non-sticky mode 0777 parent"
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("existing-volume with missing-state fails closed before creating credentials", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-failclosed-"));
    try {
      const harness = createStubDockerHarness(tempDir, { volumes: ["tenvyr_review_pgdata"] });
      const emptyRuntimeDir = join(tempDir, "empty-runtime");
      mkdirSync(emptyRuntimeDir, { mode: 0o700 });

      const res = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir: emptyRuntimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.notEqual(
        res.status,
        0,
        "Launcher must fail closed when volume exists but runtime credentials/bootstrap state is missing"
      );

      const bootstrapFiles = ["bootstrap.json", "credentials.env", "credentials.json", "users.json", "env"];
      const created = bootstrapFiles.some(f => existsSync(join(emptyRuntimeDir, f)));
      assert.equal(created, false, "Must not create credentials when failing closed on existing volume");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("bootstrap generates 3 unique users (2 SUBMITTER, 1 REVIEWER), mode 600/700, preserves bytes, and avoids public secrets", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-bootstrap-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      const res1 = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.equal(res1.status, 0, `Launcher up must succeed on first run, stderr: ${safeStderr(res1.stderr)}`);

      const createdFile = join(runtimeDir, "bootstrap.json");
      assert.ok(existsSync(createdFile), `bootstrap.json must be created inside runtime dir: ${runtimeDir}`);

      const dirStat = statSync(runtimeDir);
      assert.equal(dirStat.mode & 0o777, 0o700, "Runtime directory must have mode 0700");
      const fileStat = statSync(createdFile);
      assert.equal(fileStat.mode & 0o777, 0o600, "Bootstrap credentials file must have mode 0600");

      const rawContent = readFileSync(createdFile, "utf8");
      const users = JSON.parse(rawContent);

      assert.equal(users.length, 3, "Bootstrap must create exactly 3 distinct users");

      const usernames = new Set(users.map(u => u.username));
      assert.equal(usernames.size, 3, "All 3 usernames must be unique");

      const passwords = new Set(users.map(u => u.password));
      assert.equal(passwords.size, 3, "All 3 passwords must be unique");

      for (const p of passwords) {
        assert.doesNotMatch(p, /^(?:password123|admin|secret|testpass|password)$/i, "Public default passwords forbidden");
      }

      const submitters = users.filter(u => u.role === "SUBMITTER");
      const reviewers = users.filter(u => u.role === "REVIEWER");
      assert.equal(submitters.length, 2, "Exact role count must be 2 SUBMITTERs");
      assert.equal(reviewers.length, 1, "Exact role count must be 1 REVIEWER");

      for (const p of passwords) {
        assert.doesNotMatch(res1.stdout, new RegExp(p), "Passwords must not appear in stdout");
        assert.doesNotMatch(res1.stderr, new RegExp(p), "Passwords must not appear in stderr");
      }

      // Second up: repeated up preserves exact file bytes without duplicate user conflicts
      const res2 = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });
      assert.equal(res2.status, 0, `Repeated up must succeed, stderr: ${safeStderr(res2.stderr)}`);
      const secondRawContent = readFileSync(createdFile, "utf8");
      assert.equal(secondRawContent, rawContent, "Repeated up must preserve exact credentials file bytes");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("negative auth tests: launcher fails closed on unreachable, 401 unauthorized, and role mismatch", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-authfail-"));
    try {
      const harness = createStubDockerHarness(tempDir);
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      // 1. Unreachable auth endpoint
      const resUnreachable = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
        env: { STUB_AUTH_FAIL: "unreachable" },
      });
      assert.notEqual(resUnreachable.status, 0, "Launcher must exit non-zero when auth endpoint is unreachable");

      // 2. 401 Unauthorized
      const res401 = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
        env: { STUB_AUTH_FAIL: "401" },
      });
      assert.notEqual(res401.status, 0, "Launcher must exit non-zero when credentials return 401");

      // 3. Role mismatch
      const resRole = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
        env: { STUB_AUTH_FAIL: "wrong_role" },
      });
      assert.notEqual(resRole.status, 0, "Launcher must exit non-zero when returned role mismatches manifest");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("container ownership: cleans only newly owned containers, leaves pre-existing containers, refuses foreign conflicts", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-containers-"));
    try {
      const preexistingContainer = { id: "c_preexisting_api", project: "tenvyr-review", name: "old-api", owned: true, createdThisRun: false };
      const foreignContainer = { id: "c_foreign_db", project: "foreign-system", name: "foreign-db", owned: false, createdThisRun: false };

      const harness = createStubDockerHarness(tempDir, {
        volumes: ["tenvyr_review_pgdata"],
        containers: [preexistingContainer, foreignContainer],
      });
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });
      writeFileSync(join(runtimeDir, "bootstrap.json"), JSON.stringify([{ username: "u", password: "p", role: "SUBMITTER" }]), { mode: 0o600 });
      writeFileSync(join(runtimeDir, "credentials.env"), "TENVYR_REVIEW_DB_PASSWORD=test\nTENVYR_REVIEW_WORKER_BEARER_TOKEN=bearer\nTENVYR_REVIEW_CALLBACK_SECRET=secret\n", { mode: 0o600 });

      // 1. Refuses foreign owner conflict
      const resConflict = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
        env: { STUB_DOCKER_FOREIGN_CONFLICT: "1" },
      });
      assert.notEqual(resConflict.status, 0, "Launcher must exit non-zero on foreign ownership conflict");

      let state = JSON.parse(readFileSync(harness.stateFile, "utf8"));
      assert.ok(state.containers.some(c => c.id === foreignContainer.id), "Foreign container must remain untouched");
      assert.ok(state.containers.some(c => c.id === preexistingContainer.id), "Pre-existing container must remain untouched");

      // 2. Health failure cleans only newly owned containers and leaves pre-existing containers intact
      const resFail = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
        env: { STUB_DOCKER_FAIL_HEALTH: "1" },
      });
      assert.notEqual(resFail.status, 0, "Launcher must exit non-zero on health check failure");

      state = JSON.parse(readFileSync(harness.stateFile, "utf8"));
      assert.ok(!state.removedContainers.includes(preexistingContainer.id), "Cleanup must NOT remove pre-existing container");
      assert.ok(!state.removedContainers.includes(foreignContainer.id), "Cleanup must NOT remove foreign container");
      assert.equal(state.removedVolumes.length, 0, "Cleanup must NEVER remove persistent volume");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("down subcommand preserves volumes and credentials by default", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-down-"));
    try {
      const harness = createStubDockerHarness(tempDir, { volumes: ["tenvyr_review_pgdata"] });
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      const mockCredFile = join(runtimeDir, "credentials.env");
      writeFileSync(mockCredFile, "TENVYR_REVIEW_DB_PASSWORD=secret\nTENVYR_REVIEW_WORKER_BEARER_TOKEN=bearer\nTENVYR_REVIEW_CALLBACK_SECRET=secret\n", { mode: 0o600 });

      const res = runLauncher("down", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
      });

      assert.equal(res.status, 0, `down subcommand must exit 0, stderr: ${safeStderr(res.stderr)}`);

      const state = JSON.parse(readFileSync(harness.stateFile, "utf8"));
      assert.equal(state.removedVolumes.length, 0, "down must not remove volumes by default");
      assert.ok(existsSync(mockCredFile), "down must preserve runtime credentials file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("source build uses committed Git source of chosen revision, independent of dirty workspace targets", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tenvyr-test-git-"));
    try {
      const gitDir = join(tempDir, "repo");
      mkdirSync(gitDir, { recursive: true });

      spawnSync("git", ["init"], { cwd: gitDir });
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: gitDir });
      spawnSync("git", ["config", "user.email", "test@tenvyr.io"], { cwd: gitDir });

      mkdirSync(join(gitDir, "scripts"), { recursive: true });
      mkdirSync(join(gitDir, "backend", "review-api"), { recursive: true });
      mkdirSync(join(gitDir, "backend", "review-worker"), { recursive: true });

      if (existsSync(LAUNCHER_SH)) {
        writeFileSync(join(gitDir, "scripts", "review-showcase.sh"), readFileSync(LAUNCHER_SH, "utf8"), { mode: 0o755 });
      }
      const launcherMjs = join(ROOT, "scripts", "review-showcase.mjs");
      if (existsSync(launcherMjs)) {
        writeFileSync(join(gitDir, "scripts", "review-showcase.mjs"), readFileSync(launcherMjs, "utf8"), { mode: 0o755 });
      }
      if (existsSync(COMPOSE_REVIEW)) {
        writeFileSync(join(gitDir, "docker-compose.review.yml"), readFileSync(COMPOSE_REVIEW, "utf8"));
      }
      if (existsSync(API_DOCKERFILE)) {
        writeFileSync(join(gitDir, "backend", "review-api", "Dockerfile"), readFileSync(API_DOCKERFILE, "utf8"));
      }
      if (existsSync(WORKER_DOCKERFILE)) {
        writeFileSync(join(gitDir, "backend", "review-worker", "Dockerfile"), readFileSync(WORKER_DOCKERFILE, "utf8"));
      }

      writeFileSync(join(gitDir, "committed.txt"), "clean committed source", "utf8");
      spawnSync("git", ["add", "."], { cwd: gitDir });
      spawnSync("git", ["commit", "-m", "initial commit"], { cwd: gitDir });

      const revRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd: gitDir, encoding: "utf8" });
      const commitHash = revRes.stdout.trim();
      assert.match(commitHash, /^[0-9a-f]{40}$/i, "Committed revision must be verified 40-character SHA");

      // Dirty the tracked file and add an ignored target directory sentinel in working tree
      writeFileSync(join(gitDir, "committed.txt"), "dirty uncommitted change", "utf8");
      mkdirSync(join(gitDir, "target"), { recursive: true });
      writeFileSync(join(gitDir, "target", "sentinel.txt"), "dirty build target artifact", "utf8");

      const harness = createStubDockerHarness(tempDir);
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { mode: 0o700 });

      const res = runLauncher("up", {
        binDir: harness.binDir,
        preloadFile: harness.preloadFile,
        runtimeDir,
        logFile: harness.logFile,
        stateFile: harness.stateFile,
        cwd: gitDir,
      });

      assert.equal(res.status, 0, `up must succeed with clean git source build, stderr: ${res.stderr}`);

      const state = JSON.parse(readFileSync(harness.stateFile, "utf8"));
      assert.ok(state.buildContexts.length > 0, "Launcher must trigger docker build/compose build for images");

      const buildCall = state.buildContexts[0];
      assert.ok(buildCall, "Build context call must be recorded");

      assert.notEqual(buildCall.contextDir, gitDir, "Build context must NOT point to dirty workspace directory");

      // Immutable capture assertions while context was alive
      assert.equal(
        buildCall.committedContent,
        "clean committed source",
        "Build context must contain clean committed source, not dirty workspace change"
      );

      assert.equal(buildCall.targetExists, false, "Target directory must be absent from committed build context");

      const allBuildArgs = buildCall.args.join(" ");
      assert.ok(
        allBuildArgs.includes(commitHash) || buildCall.revision === commitHash,
        "Build invocation must provide exact committed git revision evidence"
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("T07 Smoke Runner Contract (scripts/review-smoke.mjs)", () => {
  test("review-smoke.mjs exists and does not contain hardcoded static credentials", () => {
    assert.ok(existsSync(SMOKE_MJS), "scripts/review-smoke.mjs must exist");
    const content = readFileSync(SMOKE_MJS, "utf8");

    assert.doesNotMatch(
      content,
      /password\s*:\s*["'](?:password123|admin|secret|testpass)["']/i,
      "Hardcoded public passwords forbidden"
    );
    assert.match(
      content,
      /(?:process\.env|readFileSync|credentials|bootstrap)/i,
      "Smoke client must consume generated runtime credentials"
    );
  });

  test("review-smoke.mjs exercises full review workflow with MOCK report assertion", () => {
    assert.ok(existsSync(SMOKE_MJS), "scripts/review-smoke.mjs must exist");
    const content = readFileSync(SMOKE_MJS, "utf8");

    assert.match(content, /\/api\/v1\/auth\/csrf/, "Smoke runner must fetch CSRF token");
    assert.match(content, /\/login/, "Smoke runner must perform form login");
    assert.match(content, /\/api\/v1\/reviews/, "Smoke runner must post review request");
    assert.match(content, /Idempotency-Key/i, "Smoke runner must provide Idempotency-Key");
    assert.match(content, /MOCK/, "Smoke runner must assert report evidence mode is MOCK");
    assert.match(content, /\/decisions/, "Smoke runner must exercise reviewer decision");
    assert.match(content, /\/audit/, "Smoke runner must verify audit entries");
    assert.match(content, /404/, "Smoke runner must verify foreign submitter denial returns 404");
  });
});

describe("T07 Capacity and Resource Configuration Bounds", () => {
  test("application.yml configures Tomcat 50/50, Hikari 10/2s, and actuator metrics", () => {
    assert.ok(existsSync(APP_YML), "application.yml must exist");
    const content = readFileSync(APP_YML, "utf8");

    assert.match(content, /max:\s*50/, "Tomcat max threads must be set to 50");
    assert.match(content, /accept-count:\s*50/, "Tomcat accept-count must be set to 50");
    assert.match(content, /maximum-pool-size:\s*10/, "Hikari maximum-pool-size must be 10");
    assert.match(content, /connection-timeout:\s*2000/, "Hikari connection-timeout must be 2000 ms");
    assert.match(content, /include:\s*.*metrics/, "Actuator web exposure must include metrics");
  });
});
