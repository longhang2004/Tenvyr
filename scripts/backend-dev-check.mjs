import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { statSync,
  utimesSync,
  mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "tenvyr-dev-check-"));
const project = `tenvyr-dev-check-${process.pid}`;
const override = join(directory, "compose.yml");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: `${join(root, "docker-compose.yml")}:${override}`,
  TENVYR_MAVEN_OFFLINE: "true",
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_PORT: "55441",
  TENVYR_POSTGRES_PORT: "55441",
  POSTGRES_USER: "postgres",
  POSTGRES_PASSWORD: "postgres",
  POSTGRES_DB: "tenvyr_dev_test",
  ORCHESTRATOR_PORT: "53021",
  GATEWAY_PORT: "53020",
  EXECUTOR_HOST_PORT: "53022",
  PORT: "54000",
  EXECUTOR_HOST_ALLOWED_ROOT: directory,
  EXECUTOR_HOST_STATE_DIR: join(directory, "state"),
  ORCHESTRATOR_URL: "http://127.0.0.1:53021",
  GATEWAY_URL: "http://127.0.0.1:53020",
};
delete env.TENVYR_BACKEND;
delete env.TENVYR_DEV_WATCH;
delete env.TENVYR_DEV_WATCH_CHILD;
env.TENVYR_EXECUTOR_HOST = "java";
const watchedSource = join(root, "backend/gateway/src/main/java/io/tenvyr/gateway/GatewayRoutes.java");
const originalTimes = statSync(watchedSource);
let child,
  output = "",
  exited;
function docker(args) {
  return spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
}
async function waitFor(condition, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    if (exited !== undefined)
      assert.fail(`${label}: launcher exited ${exited}\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} timed out\n${output}`);
}
try {
  const names = docker(["ps", "-a", "--format", "{{.Names}}"]);
  assert.equal(names.status, 0);
  const config = docker([
    "compose",
    "-f",
    join(root, "docker-compose.yml"),
    "config",
    "--format",
    "json",
  ]);
  assert.equal(config.status, 0);
  const base = JSON.parse(config.stdout);
  const defaults = new Set(
    Object.values(base.services).map((value) => value.container_name),
  );
  assert.ok(
    !names.stdout.split("\n").some((name) => defaults.has(name)),
    "dev check refuses existing default-stack containers",
  );
  const networkKey = Object.keys(base.networks)[0];
  writeFileSync(
    override,
    `services:\n  postgres:\n    environment:\n      POSTGRES_DB: tenvyr_dev_test\n    ports: !override ["127.0.0.1:55441:5432"]\n  redis:\n    ports: !override ["127.0.0.1:56380:6379"]\n  kafka:\n    ports: !override ["127.0.0.1:39094:9092", "127.0.0.1:39095:29092"]\n    environment:\n      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,PLAINTEXT_HOST://127.0.0.1:39095\n  kafka-ui:\n    ports: !override ["127.0.0.1:58091:8080"]\nnetworks:\n  ${networkKey}:\n    name: ${project}-net\n`,
  );
  child = spawn(process.execPath, ["scripts/dev.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  child.on("exit", (code) => {
    exited = code ?? 1;
  });
  await waitFor(
    () => output.includes("Tenvyr is ready."),
    180000,
    "real default development stack readiness",
  );
  for (const [port, path] of [
    [53021, "/health"],
    [53020, "/health"],
    [53022, "/health/live"],
    [54000, "/"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(
      response.status,
      200,
      `real development endpoint ${port}${path}`,
    );
  }
  assert.ok(output.includes("Building Java/Go backend"));
  utimesSync(watchedSource, new Date(), new Date());
  await waitFor(() => (output.match(/Tenvyr is ready\./g) || []).length >= 2, 180000, "backend source change rebuild and restart");
  child.kill("SIGINT");
  await waitFor(
    () => exited !== undefined,
    45000,
    "development stack graceful shutdown",
  );
  assert.equal(exited, 0, output);
  assert.match(output, /Tenvyr stopped cleanly/);
  for (const port of [53021, 53020, 53022, 54000]) {
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }),
      `service port ${port} must close`,
    );
  }
  console.log(
    "Default development launcher PASS: clean Java/Go build, PostgreSQL/Kafka infrastructure, Java control/gateway/native host, real frontend readiness, source-change rebuild/restart and SIGINT teardown",
  );
} catch (error) {
  process.stderr.write(output);
  throw error;
} finally {
  if (child && exited === undefined) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 20000).unref();
    });
    if (exited === undefined) child.kill("SIGKILL");
  }
  if (child) {
    const result = docker(["compose", "down", "-v", "--remove-orphans"]);
    assert.equal(result.status, 0, result.stderr);
  }
  utimesSync(watchedSource, originalTimes.atime, originalTimes.mtime);
  rmSync(directory, { recursive: true, force: true });
}
