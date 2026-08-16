#!/usr/bin/env node
/**
 * Tenvyr development launcher (`pnpm dev`).
 *
 * A bounded supervisor for the local development stack: starts the Compose
 * infrastructure (PostgreSQL, Redis, Kafka), then the orchestrator,
 * gateway, and workbench (Next.js) watch services, polls REAL readiness
 * endpoints, formats service logs through one compact formatter, and
 * coordinates a graceful Ctrl+C shutdown (children receive SIGTERM so
 * Nest shutdown hooks — including the P2 OpenCodeAuthFlow closeAll —
 * always run). It deliberately does NOT reimplement pnpm/Turbo; each
 * child is the package's own start script.
 *
 * Modes:
 *   pnpm dev           — TENVYR_LOG_LEVEL=normal (concise; Nest bootstrap
 *                        contexts suppressed at the application boundary)
 *   pnpm dev:verbose   — TENVYR_LOG_LEVEL=verbose (full framework logs)
 *
 * TTY / CI / pipes: banner, spinners, and ANSI colors only on an
 * interactive stdout; NO_COLOR disables color, FORCE_COLOR=1 forces it,
 * CI disables decoration. Redirected output stays deterministic.
 *
 * Secrets policy: never prints database passwords, API keys, OAuth
 * secrets, or OpenCode server passwords — only URLs built from the
 * actual configured ports.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load .env KEY=VALUE lines (parity with the legacy dev.sh sourcing) and
 * merge them into the process environment. Values are NEVER printed.
 */
export function loadDotEnv(root, env = process.env) {
  try {
    const content = readFileSync(join(root, ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (match) {
        const [, key, rawValue] = match;
        if (env[key] === undefined) {
          env[key] = rawValue.replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    // no .env — defaults apply
  }
  return env;
}
const DEFAULT_SERVICES = [
  { name: "orchestrator", dir: "services/orchestrator", script: "start:dev", portEnv: "ORCHESTRATOR_PORT", defaultPort: 3001, health: "/health" },
  { name: "gateway", dir: "services/gateway", script: "start:dev", portEnv: "GATEWAY_PORT", defaultPort: 3000, health: "/health" },
  { name: "workbench", dir: "frontend", script: "dev", portEnv: null, defaultPort: 4000, health: "/" },
];
const INFRA_SERVICES = ["postgres", "redis", "zookeeper", "kafka", "kafka-ui"];

/** Container names declared by the compose file (bounded lookup). */
export function composeContainerNames(root) {
  try {
    const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.status !== 0) return {};
    const config = JSON.parse(result.stdout);
    const names = {};
    for (const [service, definition] of Object.entries(config.services ?? {})) {
      names[service] = definition.container_name ?? service;
    }
    return names;
  } catch {
    return {};
  }
}

function containerRunning(name) {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

/** Start an existing but stopped container (bounded, best-effort). */
function startContainer(name) {
  spawnSync("docker", ["start", name], { stdio: "ignore", timeout: 60_000 });
}

/* ------------------------------------------------------------------ */
/* Presentation helpers (pure; exported for tests)                    */
/* ------------------------------------------------------------------ */

export function useColor(env = process.env, stdout = process.stdout) {
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "true") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  return Boolean(stdout.isTTY);
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
  bold: "\u001b[1m",
};

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The compact per-line format emitted by the in-app TenvyrDevLogger. */
export const DEV_LINE_PATTERN =
  /^\d{2}:\d{2}:\d{2}\s{2}\S+\s{2}(INFO|WARN|ERROR|DEBUG|TRACE)\s{2}/;

export function isDevLine(line) {
  return DEV_LINE_PATTERN.test(line.replace(/\u001b\[[0-9;]*m/g, ""));
}

/** Central service-log formatter: time service level message. */
export function formatServiceLine({ time, service, level, message, color = false }) {
  const t = time ?? now();
  const serviceCol = service.padEnd(11, " ");
  const levelCol = level.padEnd(5, " ");
  const firstBreak = message.indexOf("\n");
  const single = firstBreak === -1 ? message : `${message.slice(0, firstBreak)} …`;
  if (!color) return `${t}  ${serviceCol}  ${levelCol}  ${single}`;
  const levelColor =
    level === "WARN" ? ANSI.yellow : level === "ERROR" ? ANSI.red : level === "DEBUG" ? ANSI.dim : "";
  const timeText = `${ANSI.dim}${t}${ANSI.reset}`;
  return `${timeText}  ${serviceCol}  ${levelColor}${levelCol}${ANSI.reset}  ${single}`;
}

/** Tag a foreign (non-dev-format) line with the service + a level guess. */
export function wrapForeignLine(line, service, color) {
  const trimmed = line.replace(/\s+$/, "");
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const cleanError = /(^|\s)(0|no) errors?([.\s]|$)/.test(lower);
  const level = !cleanError && /error|fail|exception/.test(lower)
    ? "ERROR"
    : /warn/.test(lower)
      ? "WARN"
      : "INFO";
  return formatServiceLine({ service, level, message: trimmed, color });
}

export function bannerText(color) {
  if (!color) return ["TENVYR — Agent Execution Control Plane"];
  return [
    `${ANSI.cyan}${ANSI.bold}  ◈ TENVYR${ANSI.reset}`,
    `${ANSI.dim}  Agent Execution Control Plane${ANSI.reset}`,
  ];
}

export function statusMark(state, color) {
  if (!color)
    return state === "ready" || state === "stopped"
      ? "✓"
      : state === "disabled"
        ? "○"
        : state === "failed"
          ? "✕"
          : state === "warn"
            ? "!"
            : "?";
  if (state === "ready") return `${ANSI.green}✓${ANSI.reset}`;
  if (state === "disabled") return `${ANSI.dim}○${ANSI.reset}`;
  if (state === "failed") return `${ANSI.red}✕${ANSI.reset}`;
  if (state === "stopped") return `${ANSI.dim}✓${ANSI.reset}`;
  return `${ANSI.yellow}!${ANSI.reset}`;
}

export function summaryBlock({ mode, services, kafkaState, color }) {
  const lines = [];
  lines.push("");
  lines.push(color ? `${ANSI.dim}  Runtime${ANSI.reset}` : "  Runtime");
  lines.push(`  ├─ Mode       ${mode}`);
  for (const service of services) {
    const url = service.url
      ? color
        ? ` ${ANSI.dim}· ${service.url}${ANSI.reset}`
        : ` · ${service.url}`
      : "";
    lines.push(`  ├─ ${service.label.padEnd(10)} ${service.state}${url}`);
  }
  lines.push(`  ├─ Database   PostgreSQL · ${kafkaState.database}`);
  lines.push(`  └─ Kafka      ${kafkaState.broker}`);
  lines.push("");
  if (color) {
    lines.push(`  ${ANSI.green}Tenvyr is ready.${ANSI.reset}`);
  } else {
    lines.push("  Tenvyr is ready.");
  }
  lines.push("");
  lines.push(`  Workbench → http://localhost:${servicePort(services, "workbench")}`);
  lines.push("");
  lines.push("  Ctrl+C to stop · `pnpm dev:verbose` for framework logs");
  return lines;
}

function servicePort(services, name) {
  const service = services.find((s) => s.name === name);
  return service ? service.port : "4000";
}

/* ------------------------------------------------------------------ */
/* Supervisor                                                         */
/* ------------------------------------------------------------------ */

function envWith(env, extra) {
  return { ...env, ...extra };
}

async function waitFor(predicate, timeoutMs, label, log) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log("ERROR", `${label} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

async function fetchReady(url, timeoutMs, jsonHealth = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    if (!jsonHealth) return true; // any 2xx (e.g. the workbench page)
    const body = await res.json().catch(() => null);
    const status = body?.data?.status ?? body?.status ?? "";
    const statusText = String(status).toUpperCase();
    return statusText.includes("UP") || statusText.includes("OK") || statusText.includes("READY");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Run one child with piped stdio; forward formatted lines. */
function startChild(child, io, log) {
  const { command, args, env, name, label } = child;
  const process_ = spawn(command, args, {
    env,
    cwd: child.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Detached so shutdown can signal the WHOLE tree (pnpm -> nest -> app):
    // the app process receives SIGTERM and its Nest shutdown hooks run
    // (P2 closeAll semantics preserved).
    detached: true,
  });
  process_.name = name;
  process_.label = label;
  const emit = (chunk, isStderr) => {
    let text = String(chunk)
      // Watcher CLIs (nest start --watch) emit full-screen clears that
      // would wipe the launcher's own summary in a real terminal —
      // neutralize them (well-defined ANSI, not a text-content filter).
      .replace(/\x1b\[[0-9;]*[HJ]/g, "")
      .replace(/\x1b\[\?[0-9]*[hl]/g, "");
    if (!io.color) {
      // Non-interactive / NO_COLOR / CI: strip framework ANSI (e.g. the
      // nest CLI's own gray timestamps) so redirects stay deterministic
      // and searchable.
      text = text.replace(/\x1b\[[0-9;]*m/g, "");
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) continue;
      if (isDevLine(line)) {
        io.write(line + "\n"); // already formatted by the app logger
      } else {
        const wrapped = wrapForeignLine(line, name, io.color);
        if (wrapped) io.write(wrapped + "\n");
      }
    }
  };
  process_.stdout?.on("data", (chunk) => emit(chunk, false));
  process_.stderr?.on("data", (chunk) => emit(chunk, true));
  process_.on("exit", (code, signal) => {
    log(
      code === 0 || signal === "SIGTERM" ? "INFO" : "ERROR",
      `${label} exited (${signal ? `signal ${signal}` : `code ${code}`})`,
    );
    child.onExit?.(code, signal);
  });
  return process_;
}

/** Build the child manifest from repo truth. */
export function buildManifest(env = process.env) {
  const portOf = (service) =>
    Number(env[service.portEnv] ?? service.defaultPort);
  const services = DEFAULT_SERVICES.map((service) => {
    const port = portOf(service);
    const processEnv = envWith(env, { TENVYR_LOG_LEVEL: env.TENVYR_LOG_LEVEL ?? "normal" });
    return {
      ...service,
      port,
      label: service.name[0].toUpperCase() + service.name.slice(1),
      url: `http://localhost:${port}`,
      command: "pnpm",
      args: ["run", service.script],
      cwd: join(ROOT, service.dir),
      env: processEnv,
    };
  });
  return { services, infraServices: INFRA_SERVICES, root: ROOT };
}

/** Real launcher entry. Exported for the deterministic tests. */
export async function runLauncher(
  manifest,
  io = {
    write: (text) => process.stdout.write(text),
    color: useColor(),
    log: () => undefined,
    mode: process.env.TENVYR_LOG_LEVEL ?? "normal",
    isInteractive: process.stdout.isTTY && !process.env.CI,
  },
) {
  const color = io.color;
  const mode = io.mode;
  const log = (level, message) => {
    io.write(formatServiceLine({ service: "dev", level, message, color }) + "\n");
  };

  if (io.isInteractive) {
    for (const line of bannerText(color)) io.write(line + "\n");
    io.write("\n  Starting development environment...\n\n");
  }

  const children = [];
  const states = new Map();
  const serviceByName = new Map(manifest.services.map((s) => [s.name, s]));
  let shutdownRequested = false;
  let failed = false;

  /* --- infrastructure --- */
  const infraServices = manifest.infraServices ?? [];
  if (infraServices.length > 0) {
    log("INFO", "Starting infrastructure (docker compose)...");
    const compose = spawnSync(
      "docker",
      ["compose", "up", "-d", ...infraServices],
      { cwd: manifest.root, stdio: "ignore", timeout: 120_000 },
    );
    if (compose.status !== 0) {
      // Idempotent dev UX: `pnpm dev` with infra already running (e.g. a
      // container renamed by the backup tooling, or a previous session)
      // must not fail. Probe the declared container names; only fail when
      // required containers are genuinely missing.
      const names = composeContainerNames(manifest.root);
      const unavailable = infraServices.filter((service) => {
        const name = names[service] ?? service;
        if (containerRunning(name)) return false;
        // The container exists but is stopped (e.g. compose up conflicts
        // with a renamed sibling, or a previous `compose down`) — start it.
        startContainer(name);
        return !containerRunning(name);
      });
      if (unavailable.length === 0) {
        log("INFO", "Infrastructure already present — reusing it");
      } else {
        log("ERROR", `docker compose up failed; unavailable: ${unavailable.join(", ")}`);
        return { exitCode: 1, ready: false };
      }
    }
  }

  /* --- PostgreSQL readiness (real probe, not process liveness) --- */
  let databaseReady = false;
  if (infraServices.includes("postgres")) {
    const containerName = composeContainerNames(manifest.root).postgres ?? "postgres";
    const probe = () => {
      const result = spawnSync(
        "docker",
        ["compose", "exec", "-T", "postgres", "pg_isready"],
        { cwd: manifest.root, stdio: "ignore", timeout: 10_000 },
      );
      if (result.status === 0) return true;
      // compose exec can fail when the container is not part of this
      // project (renamed by tooling) — probe the container directly.
      // (docker exec has no -T flag; that is compose exec syntax.)
      const direct = spawnSync(
        "docker",
        ["exec", containerName, "pg_isready"],
        { stdio: "ignore", timeout: 10_000 },
      );
      return direct.status === 0;
    };
    databaseReady = await waitFor(probe, 90_000, "PostgreSQL", log);
    if (!databaseReady) {
      log("ERROR", "PostgreSQL did not become ready");
      failed = true;
    } else {
      log("INFO", "PostgreSQL ready");
    }
  }

  /* --- start children --- */
  for (const service of manifest.services) {
    const child = startChild(
      {
        ...service,
        env: envWith(service.env, {
          ...(service.portEnv ? { [service.portEnv]: String(service.port) } : {}),
        }),
      },
      io,
      log,
    );
    children.push(child);
    states.set(service.name, "starting");
  }

  /* --- readiness gates: a live process is NOT readiness --- */
  const readinessTimeoutMs = io.readinessTimeoutMs ?? 180_000;
  for (const service of manifest.services) {
    const url = `${service.url}${service.health}`;
    const jsonHealth = service.health !== "/";
    const ready = await waitFor(() => fetchReady(url, 3_000, jsonHealth), readinessTimeoutMs, service.label, log);
    states.set(service.name, ready ? "ready" : "failed");
    if (ready) {
      log("INFO", `${service.label} ready · ${service.url}`);
    } else {
      failed = true;
    }
  }

  /* --- Kafka: proven fact from the compose state --- */
  let kafkaBroker = "disabled";
  if (infraServices.includes("kafka")) {
    try {
      const kafkaUp = spawnSync("docker", ["compose", "ps", "-q", "kafka"], {
        cwd: manifest.root,
        encoding: "utf8",
        timeout: 15_000,
      });
      const containerId = (kafkaUp.stdout ?? "").trim();
      const running =
        containerId.length > 0
          ? spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", containerId], {
              encoding: "utf8",
              timeout: 15_000,
            })
          : { status: 1, stdout: "" };
      kafkaBroker =
        kafkaUp.status === 0 &&
        containerId.length > 0 &&
        running.status === 0 &&
        (running.stdout ?? "").trim() === "true"
          ? "started"
          : "disabled";
    } catch {
      kafkaBroker = "disabled";
    }
  }

  /* --- summary --- */
  if (!failed) {
    for (const line of summaryBlock({
      mode,
      services: manifest.services.map((s) => ({
        label: s.label,
        state: states.get(s.name),
        url: states.get(s.name) === "ready" ? s.url : undefined,
      })),
      kafkaState: { database: databaseReady ? "ready" : "failed", broker: kafkaBroker },
      color,
    })) {
      io.write(line + "\n");
    }
  } else {
    io.write("\n");
    for (const service of manifest.services) {
      const state = states.get(service.name);
      io.write(
        `  ${statusMark(state, color)} ${service.label.padEnd(12)} ${state === "ready" ? "ready" : state === "starting" ? "starting" : "failed"}\n`,
      );
    }
    io.write(
      color
        ? `\n  ${ANSI.red}Tenvyr did not start successfully.${ANSI.reset}\n\n  Run: pnpm dev:verbose\n`
        : "\n  Tenvyr did not start successfully.\n\n  Run: pnpm dev:verbose\n",
    );
  }

  /* --- forward until shutdown: on startup failure the launcher shuts
     down by itself and exits non-zero; on success it waits for Ctrl+C. --- */
  if (!failed) {
    await new Promise((resolve) => {
      const onSignal = () => {
        shutdownRequested = true;
        resolve();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    });
  } else {
    // Give the failure summary a beat to be read, then tear down.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  /* --- graceful shutdown: SIGTERM children, bounded, SIGKILL last --- */
  io.write("\n  Stopping Tenvyr...\n\n");
  for (const child of children) {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        // Signal the whole tree so the Nest app receives SIGTERM and its
        // shutdown hooks (P2 closeAll) run before the watchers exit.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  const deadline = Date.now() + 15_000;
  for (const child of children) {
    const remaining = Math.max(1, deadline - Date.now());
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), remaining);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && child.exitCode === null) {
      io.write(
        `  ${statusMark("warn", color)} ${child.label ?? child.name} did not exit within 15s — terminating\n`,
      );
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      io.write(`  ${statusMark("stopped", color)} ${child.label ?? child.name} stopped\n`);
    }
  }

  /* --- infra teardown (parity with the legacy dev.sh) --- */
  if (infraServices.length > 0) {
    spawnSync("docker", ["compose", "down"], { cwd: manifest.root, stdio: "ignore", timeout: 60_000 });
  }
  io.write(color ? `\n  ${ANSI.green}Tenvyr stopped cleanly.${ANSI.reset}\n` : "\n  Tenvyr stopped cleanly.\n");
  return { exitCode: failed ? 1 : 0, ready: !failed && !shutdownRequested };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadDotEnv(ROOT);
  // Parity with the legacy dev.sh: TENVYR_POSTGRES_PORT drives POSTGRES_PORT.
  if (process.env.POSTGRES_PORT === undefined) {
    process.env.POSTGRES_PORT = process.env.TENVYR_POSTGRES_PORT ?? "5432";
  }
  const manifest = buildManifest();
  runLauncher(manifest).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
