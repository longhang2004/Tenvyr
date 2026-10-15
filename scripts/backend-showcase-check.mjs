import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cutover = process.argv.includes("--cutover");
const id = `${Date.now().toString(36)}-${process.pid}`;
const project = `tenvyr-java-showcase-${id}`;
const version = `java-check-${id}`;
const directory = mkdtempSync(join(tmpdir(), "tenvyr-java-showcase-"));
const override = join(directory, "isolation.yml");
const env = {
  ...process.env,
  TENVYR_VERSION: version,
  TENVYR_SOURCE_REVISION: "unknown",
  TENVYR_POSTGRES_PORT: "55439",
  LLM_PROVIDER: "mock",
  LLM_FAILURE_MODE: "mock",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  SHOWCASE_WORKER_TOKEN: "tenvyr-test-worker",
  SHOWCASE_CALLBACK_SECRET: "tenvyr-test-callback",
};
const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
function ok(command, args, options) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
let created = false;
const files = [
  "-f",
  "docker-compose.yml",
  ...(cutover ? [] : ["-f", "docker-compose.java.yml"]),
  "-f",
  "docker-compose.showcase.yml",
  "-f",
  override,
];
const compose = ["compose", "-p", project, ...files];
try {
  const names = ok("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  const base = JSON.parse(
    ok("docker", [
      "compose",
      "-f",
      "docker-compose.yml",
      "config",
      "--format",
      "json",
    ]),
  );
  const defaultNames = new Set(
    Object.values(base.services).map((service) => service.container_name),
  );
  assert.ok(
    !names.split("\n").some((name) => defaultNames.has(name)),
    "disposable showcase refuses existing default-stack container names",
  );
  const networkKey = Object.keys(base.networks)[0];
  assert.ok(networkKey, "default stack declares its network");
  if (cutover) {
    assert.equal(
      ok("git", ["status", "--porcelain"]).trim(),
      "",
      "verified cutover requires a clean committed source tree",
    );
    env.TENVYR_SOURCE_REVISION = ok("git", ["rev-parse", "HEAD"]).trim();
  }
  writeFileSync(
    override,
    `services:
  postgres:
    ports: !override ["127.0.0.1:55439:5432"]
  redis:
    ports: !override ["127.0.0.1:56379:6379"]
  kafka:
    ports: !override ["127.0.0.1:39092:9092", "127.0.0.1:39093:29092"]
    environment:
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,PLAINTEXT_HOST://127.0.0.1:39093
  kafka-ui:
    ports: !override ["127.0.0.1:58090:8080"]
  agent-runner:
    ports: !override ["127.0.0.1:58085:8085"]
  frontend:
    ports: !override ["127.0.0.1:4000:4000"]
  python-worker:
    ports: !override ["127.0.0.1:58080:8080"]
networks:
  ${networkKey}:
    name: ${project}-net
`,
  );
  ok("docker", [...compose, "config", "--quiet"]);
  ok("docker", [...compose, "build"], { timeout: 1200000 });
  created = true;
  ok("docker", [...compose, "up", "-d"], { timeout: 300000 });
  const smoke = run(process.execPath, ["scripts/smoke-e2e.mjs"], {
    env: {
      ...env,
      SMOKE_RUNNER_URL: "http://127.0.0.1:58085",
      SMOKE_PYTHON_WORKER_URL: "http://127.0.0.1:58080",
    },
    timeout: 300000,
  });
  process.stdout.write(smoke.stdout || "");
  assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
  for (const service of [
    "orchestrator",
    "gateway",
    "agent-code-reviewer",
    "agent-observability",
  ]) {
    const container = ok("docker", [...compose, "ps", "-q", service]).trim();
    assert.ok(container, `${service} is running`);
    const node = run("docker", [
      "exec",
      container,
      "sh",
      "-c",
      "command -v node",
    ]);
    assert.ok(
      [1, 127].includes(node.status) && node.stdout.trim() === "",
      `${service} image must not contain a hidden Node backend`,
    );
    const processList = ok("docker", ["top", container, "-eo", "pid,args"]);
    assert.match(
      processList,
      /java .*io\.tenvyr\./,
      `${service} runs its actual Java entrypoint`,
    );
    if (cutover) {
      const values = JSON.parse(
        ok("docker", [
          "inspect",
          "--format",
          "{{json .Config.Env}}",
          container,
        ]),
      );
      assert.ok(
        values.includes(`TENVYR_SOURCE_REVISION=${env.TENVYR_SOURCE_REVISION}`),
        `${service} source identity matches the committed cutover`,
      );
    }
  }
  console.log(
    `${cutover ? "Verified default cutover" : "Java candidate showcase"} PASS: real PostgreSQL/Kafka/Python Worker/Java runner/frontend; Java-only backend processes${cutover ? `; source ${env.TENVYR_SOURCE_REVISION}` : ""}`,
  );
} catch (error) {
  if (created)
    process.stderr.write(
      run("docker", [...compose, "logs", "--no-color", "--tail", "80"], {
        timeout: 30000,
      }).stdout || "",
    );
  throw error;
} finally {
  if (created) {
    const cleanup = run(
      "docker",
      [...compose, "down", "-v", "--remove-orphans"],
      { timeout: 120000 },
    );
    if (cleanup.status !== 0)
      console.error(
        "Disposable showcase cleanup failed; inspect project",
        project,
      );
  }
  rmSync(directory, { recursive: true, force: true });
}
