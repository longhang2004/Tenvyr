import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const setupSource = readFileSync("scripts/setup-check.mjs", "utf8");
const dockerIgnore = new Set(
  readFileSync(".dockerignore", "utf8").split(/\r?\n/).filter(Boolean),
);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const contractServiceDockerfiles = [
  "services/orchestrator/Dockerfile",
  "services/agent-code-reviewer/Dockerfile",
  "services/agent-observability/Dockerfile",
];

test("setup checker requires the release toolchain versions", () => {
  assert.match(
    setupSource,
    /"Node\.js",\s*process\.execPath,\s*\["--version"\],\s*22,/s,
  );
  assert.match(setupSource, /"Java", "java", \["-version"\], 17,/);
  assert.match(setupSource, /"Maven",\s*"mvn",\s*\["--version"\],\s*3,/s);
});

test("Docker context excludes secrets, owner artifacts, and local caches", () => {
  for (const pattern of [
    ".env",
    ".env.*",
    "!.env.example",
    "*.zip",
    "scripts/compress.sh",
    "**/node_modules",
    "**/.venv",
    "**/__pycache__",
  ]) {
    assert(dockerIgnore.has(pattern), pattern);
  }
  for (const source of ["examples", "packages", "sdks", "services"]) {
    assert(!dockerIgnore.has(source), source);
  }
});

test("contract-dependent service images include the schema build helper", () => {
  const copy =
    "COPY scripts/copy-contract-schemas.mjs ./scripts/copy-contract-schemas.mjs";
  for (const path of contractServiceDockerfiles) {
    const source = readFileSync(path, "utf8");
    const copyIndex = source.indexOf(copy);
    assert.notEqual(copyIndex, -1, path);
    assert(copyIndex < source.indexOf("FROM base AS development"), path);
  }
});

test("showcase startup overrides auto-loaded env only when shell values are unset", () => {
  assert.match(
    manifest.scripts["showcase:up"],
    /^export LLM_PROVIDER="\$\{LLM_PROVIDER-mock\}" LLM_FAILURE_MODE="\$\{LLM_FAILURE_MODE-\}";/,
  );
  assert.match(readFileSync(".env.example", "utf8"), /^LLM_FAILURE_MODE=$/m);
});
