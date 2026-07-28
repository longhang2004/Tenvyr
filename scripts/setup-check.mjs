#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

const checks = [];

function record(status, name, detail, action = "none") {
  checks.push({ status, name, detail, action });
  console.log(`${status} ${name}: ${detail}`);
  console.log(`action: ${action}`);
}

function run(command, args = []) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function firstVersion(value) {
  return value.match(/\d+(?:\.\d+)+/)?.[0];
}

function major(value) {
  const version = firstVersion(value);
  return version ? Number(version.split(".")[0]) : undefined;
}

function checkTool(name, command, args, minimumMajor, action) {
  const result = run(command, args);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    record("FAIL", name, "not available", action);
    return;
  }
  const version = firstVersion(output) ?? output.split("\n")[0];
  const foundMajor = major(output);
  if (foundMajor === undefined || foundMajor < minimumMajor) {
    record(
      "FAIL",
      name,
      `found ${version || "unknown version"}; need ${minimumMajor}+`,
      action,
    );
    return;
  }
  record("PASS", name, version);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootLockIsSynchronized() {
  if (!existsSync("package.json") || !existsSync("pnpm-lock.yaml")) {
    return false;
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
  const packageManagerMajor = Number(
    manifest.packageManager?.match(/^pnpm@(\d+)/)?.[1],
  );
  const lockfileMajor = Number(
    lockfile.match(/^lockfileVersion:\s*['"]?(\d+)/m)?.[1],
  );
  if (!packageManagerMajor || packageManagerMajor !== lockfileMajor)
    return false;

  const rootImporter = lockfile.match(
    /^  \.:\n([\s\S]*?)(?=^  \S[^\n]*:\n|^\S)/m,
  )?.[1];
  if (!rootImporter) return false;

  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  return Object.entries(dependencies).every(([name, specifier]) => {
    const dependency = escapeRegExp(name);
    const version = escapeRegExp(specifier);
    return new RegExp(
      `^      ['"]?${dependency}['"]?:\\n        specifier: ['"]?${version}['"]?$`,
      "m",
    ).test(rootImporter);
  });
}

function parseEnvironmentFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        value = value.replace(/\s+#.*$/, "").trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );
}

function usableCredential(value) {
  const normalized = value?.trim().toLowerCase();
  return Boolean(
    normalized &&
    !normalized.includes("your-") &&
    !normalized.includes("api-key-here") &&
    normalized !== "changeme",
  );
}

function validateProviderConfiguration(environment) {
  const provider = (environment.LLM_PROVIDER || "mock").trim().toLowerCase();
  const failureMode = (environment.LLM_FAILURE_MODE || "").trim().toLowerCase();
  const issues = [];

  if (!new Set(["mock", "openai", "anthropic", "ollama"]).has(provider)) {
    issues.push(`LLM_PROVIDER=${provider || "<blank>"} is unsupported`);
  }
  if (!new Set(["", "fail", "mock"]).has(failureMode)) {
    issues.push(
      `LLM_FAILURE_MODE=${failureMode || "<blank>"} must be blank, fail, or mock`,
    );
  }

  if (provider === "openai") {
    if (!usableCredential(environment.OPENAI_API_KEY)) {
      issues.push("OPENAI_API_KEY is missing or still a placeholder");
    }
    if (!(environment.OPENAI_MODEL || "gpt-4o-mini").trim()) {
      issues.push("OPENAI_MODEL is missing");
    }
  } else if (provider === "anthropic") {
    if (!usableCredential(environment.ANTHROPIC_API_KEY)) {
      issues.push("ANTHROPIC_API_KEY is missing or still a placeholder");
    }
    if (!(environment.ANTHROPIC_MODEL || "claude-3-5-haiku-latest").trim()) {
      issues.push("ANTHROPIC_MODEL is missing");
    }
  } else if (provider === "ollama") {
    const url = (
      environment.OLLAMA_API_URL || "http://host.docker.internal:11434"
    ).trim();
    if (!(environment.OLLAMA_MODEL || "llama3.1").trim()) {
      issues.push("OLLAMA_MODEL is missing");
    }
    try {
      const parsed = new URL(url);
      if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error();
    } catch {
      issues.push("OLLAMA_API_URL must be an HTTP(S) URL");
    }
  }

  return { provider, failureMode, issues };
}

function findPython() {
  const candidates = [
    process.env.TENVYR_PYTHON_EXECUTABLE,
    "python3.14",
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
  ].filter(Boolean);
  for (const command of candidates) {
    const result = run(command, [
      "-c",
      "import sys; print('.'.join(map(str, sys.version_info[:3]))); raise SystemExit(sys.version_info < (3, 11))",
    ]);
    if (!result.error && result.status === 0) {
      return { command, version: result.stdout.trim() };
    }
  }
  return undefined;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

checkTool(
  "Node.js",
  process.execPath,
  ["--version"],
  22,
  "Install Node.js 22 or newer.",
);
checkTool(
  "pnpm",
  "pnpm",
  ["--version"],
  9,
  "Enable Corepack and install pnpm 9.",
);
checkTool(
  "Prettier executable",
  "pnpm",
  ["exec", "prettier", "--version"],
  3,
  "Run pnpm install --frozen-lockfile.",
);
const python = findPython();
if (python) {
  record("PASS", "Python", `${python.version} (${python.command})`);
} else {
  record(
    "FAIL",
    "Python",
    "Python 3.11 or newer is not available",
    "Install Python 3.11 or newer.",
  );
}
checkTool("Java", "java", ["-version"], 17, "Install JDK 17 or newer.");
checkTool("Maven", "mvn", ["--version"], 3, "Install Apache Maven 3 or newer.");
checkTool(
  "Docker",
  "docker",
  ["--version"],
  20,
  "Install Docker Desktop or Docker Engine.",
);
checkTool(
  "Docker Compose",
  "docker",
  ["compose", "version"],
  2,
  "Install Docker Compose v2 or newer.",
);

const dockerInfo = run("docker", [
  "info",
  "--format",
  "{{.ServerVersion}}",
]).stdout?.trim();
if (dockerInfo) {
  record("PASS", "Docker daemon", `server ${dockerInfo}`);
} else {
  record(
    "FAIL",
    "Docker daemon",
    "not reachable",
    "Start Docker and rerun pnpm setup:check.",
  );
}

if (rootLockIsSynchronized()) {
  record("PASS", "Dependency lock", "root manifest matches pnpm-lock.yaml");
} else {
  record(
    "FAIL",
    "Dependency lock",
    "package.json and pnpm-lock.yaml are not synchronized",
    "Run pnpm install and commit the updated pnpm-lock.yaml.",
  );
}

const pythonDependencies = python
  ? run(python.command, ["-c", "import tenvyr_worker"])
  : undefined;
if (pythonDependencies?.status === 0) {
  record("PASS", "Python dependencies", "tenvyr_worker is importable");
} else {
  record(
    "WARN",
    "Python dependencies",
    "tenvyr_worker is not installed in the selected host interpreter; Docker installs it during showcase build",
    "For local Python tests, install sdks/python-worker with its dev extra in a virtual environment.",
  );
}

if (existsSync(".env.example")) {
  record("PASS", "Environment template", ".env.example is present");
} else {
  record(
    "FAIL",
    "Environment template",
    ".env.example is missing",
    "Restore .env.example from the repository.",
  );
}
if (existsSync(".env")) {
  record("PASS", "Local environment", ".env is present");
} else {
  record(
    "WARN",
    "Local environment",
    ".env is absent; offline showcase defaults still work",
    "Copy .env.example to .env only when overriding provider settings.",
  );
}

const environmentFile = existsSync(".env") ? ".env" : ".env.example";
const providerConfiguration = validateProviderConfiguration({
  ...parseEnvironmentFile(environmentFile),
  ...process.env,
});
if (providerConfiguration.issues.length === 0) {
  record(
    "PASS",
    "LLM provider configuration",
    `${providerConfiguration.provider}; failure mode ${providerConfiguration.failureMode || "derived by provider"}`,
  );
} else {
  record(
    "FAIL",
    "LLM provider configuration",
    providerConfiguration.issues.join("; "),
    `Fix ${environmentFile} or the overriding shell environment.`,
  );
}

const schema = python
  ? run(python.command, ["scripts/sync-python-worker-schemas.py", "check"])
  : undefined;
if (schema?.status === 0) {
  record(
    "PASS",
    "Schema synchronization",
    "Python Worker schemas match canonical contracts",
  );
} else {
  record(
    "FAIL",
    "Schema synchronization",
    "schema check failed",
    "Run python3 scripts/sync-python-worker-schemas.py check and resolve the reported mismatch.",
  );
}

const ports = [
  3000, 3001, 3002, 3003, 4000, 5432, 6379, 8080, 8085, 8090, 9092, 29092,
];
const occupied = [];
for (const port of ports) {
  if (!(await portIsFree(port))) occupied.push(port);
}
if (occupied.length === 0) {
  record("PASS", "Required ports", ports.join(", "));
} else {
  record(
    "FAIL",
    "Required ports",
    `occupied: ${occupied.join(", ")}`,
    "Stop the conflicting services or configure equivalent local port overrides.",
  );
}

const failures = checks.filter(({ status }) => status === "FAIL").length;
const warnings = checks.filter(({ status }) => status === "WARN").length;
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} setup: ${failures} failure(s), ${warnings} warning(s)`,
);
process.exitCode = failures === 0 ? 0 : 1;

export {
  firstVersion,
  major,
  parseEnvironmentFile,
  rootLockIsSynchronized,
  validateProviderConfiguration,
};
