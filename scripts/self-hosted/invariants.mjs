#!/usr/bin/env node
/**
 * M11-S4: executable self-hosted invariants.
 *
 * `pnpm self-hosted:invariants` verifies the deployed stack truthfully:
 *   1. the compose file resolves (valid config, required env references),
 *   2. the environment contract holds (POSTGRES_* + ORCHESTRATOR_PORT /
 *      GATEWAY_PORT; no DATABASE_URL / REDIS_URL / bare PORT:; no floating
 *      image tags),
 *   3. orchestrator and gateway report healthy/ready on their loopback
 *      ports.
 *
 * Exits non-zero with the violation list. The pure checks are exported so
 * the contract test can exercise them executably.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..", "..");

export const composeResolves = (stdout) => {
  if (typeof stdout !== "string" || stdout.length === 0) {
    return { ok: false, reason: "compose config produced no output" };
  }
  return { ok: true };
};

export const checkEnvironmentContract = (composeYaml) => {
  const violations = [];
  const orchestrator = composeYaml.match(/orchestrator:\n(?:.*\n)*?  gateway:/)?.[0] ?? "";
  if (!orchestrator.includes("ORCHESTRATOR_PORT")) {
    violations.push("orchestrator env must set ORCHESTRATOR_PORT");
  }
  if (orchestrator.includes("DATABASE_URL")) {
    violations.push("orchestrator env must NOT set DATABASE_URL (dead config)");
  }
  if (orchestrator.includes("REDIS_URL")) {
    violations.push("orchestrator env must NOT set REDIS_URL (redis removed)");
  }
  for (const line of orchestrator.split("\n")) {
    if (/^\s+PORT: /.test(line)) {
      violations.push("orchestrator env must NOT assign bare PORT: (must be ORCHESTRATOR_PORT)");
    }
  }
  if (!composeYaml.includes("GATEWAY_PORT")) {
    violations.push("gateway env must set GATEWAY_PORT");
  }
  if (!composeYaml.includes("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD")) {
    violations.push("POSTGRES_PASSWORD must be an env-file reference, never a literal");
  }
  return violations;
};

export const checkPinnedImages = (composeYaml) => {
  const violations = [];
  for (const line of composeYaml.split("\n")) {
    const match = line.match(/^\s+image:\s*(\S+)/);
    if (!match) continue;
    const image = match[1];
    if (image.endsWith(":latest") || !image.includes(":")) {
      violations.push(`image "${image}" is not pinned to a version`);
    }
  }
  return violations;
};

export const checkHealth = (port, expected) => {
  const result = spawnSync("curl", ["-s", `http://127.0.0.1:${port}/health`], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return { ok: false, reason: `no health response on :${port}` };
  if (!result.stdout.includes(expected)) {
    return { ok: false, reason: `health on :${port} did not include ${JSON.stringify(expected)}` };
  }
  return { ok: true };
};

export const main = () => {
  const violations = [];
  if (!existsSync(join(ROOT, "deploy.env"))) {
    violations.push("deploy.env is missing (run bootstrap first)");
  }
  // The environment contract and pinned-image checks apply to the SOURCE
  // profile (its declared env references and image tags); the resolved
  // config is validated separately for resolvability.
  const sourceCompose = readFileSync(
    join(ROOT, "docker-compose.self-hosted.yml"),
    "utf8",
  );
  violations.push(...checkEnvironmentContract(sourceCompose));
  violations.push(...checkPinnedImages(sourceCompose));
  const compose = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.self-hosted.yml", "--env-file", "deploy.env", "config"],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  if (compose.status !== 0) {
    violations.push(`compose config failed: ${compose.stderr?.slice(0, 400)}`);
  } else if (!composeResolves(compose.stdout).ok) {
    violations.push(composeResolves(compose.stdout).reason);
  }
  const orchestratorHealth = checkHealth(3001, '"ready":true');
  if (!orchestratorHealth.ok) violations.push(orchestratorHealth.reason);
  const gatewayHealth = checkHealth(3000, "UP");
  if (!gatewayHealth.ok) violations.push(gatewayHealth.reason);

  if (violations.length > 0) {
    console.error("[invariants] FAIL:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("[invariants] OK: compose resolves, environment contract holds, images pinned, services healthy");
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
