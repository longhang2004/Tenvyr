import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A real original-Node -> Java source-build upgrade, confined to a disposable clone/project.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "tenvyr-upgrade-check-"));
const checkout = join(directory, "source");
const project = `tenvyr-upgrade-check-${process.pid}`;
const current = `v0.0.${Date.now()}`;
const target = `v0.0.${Number(current.split(".")[2]) + 1}`;
const deploy = join(directory, "deploy.env");
const maintenance = join(directory, "backups");
const baseline = join(directory, "original.yml");
const prefix = project;
const env = {
  ...process.env,
  TENVYR_ROOT: checkout,
  TENVYR_DEPLOY_ENV: deploy,
  TENVYR_SELF_HOSTED_COMPOSE: "docker-compose.self-hosted.yml",
  TENVYR_SELF_HOSTED_PROJECT: project,
  TENVYR_SELF_HOSTED_PREFIX: prefix,
  TENVYR_POSTGRES_CONTAINER: `${prefix}-postgres`,
  TENVYR_POSTGRES_PORT: "55440",
  TENVYR_ORCHESTRATOR_PORT: "53011",
  TENVYR_GATEWAY_PORT: "53010",
  TENVYR_MAINTENANCE_DIR: maintenance,
};
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: checkout,
    env,
    encoding: "utf8",
    timeout: 900000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}
function ok(command, args, options) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  join(checkout, "docker-compose.self-hosted.yml"),
  "--env-file",
  deploy,
];
let created = false;
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:53011${path}`, {
    signal: AbortSignal.timeout(15000),
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
}
async function ready() {
  for (let i = 0; i < 90; i++) {
    try {
      const value = await api("/health");
      if (value.data?.ready || value.ready) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail("disposable upgrade deployment did not become ready");
}
const sql = (query) =>
  ok("docker", [
    "exec",
    `${prefix}-postgres`,
    "psql",
    "-U",
    "tenvyr",
    "-d",
    "tenvyr",
    "-tA",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  ]).trim();
try {
  assert.equal(
    ok("git", ["status", "--porcelain"], { cwd: root }).trim(),
    "",
    "upgrade proof requires committed clean sources",
  );
  const sha = ok("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  assert.ok(
    !ok("docker", ["ps", "-a", "--format", "{{.Names}}"], { cwd: root })
      .split("\n")
      .some((name) => name.startsWith(`${prefix}-`)),
    "refuse an existing upgrade test installation",
  );
  ok("git", ["clone", "--no-hardlinks", "--quiet", root, checkout], {
    cwd: directory,
  });
  ok("git", ["tag", target]); // Only this disposable clone receives the test release tag.
  writeFileSync(
    deploy,
    `POSTGRES_PASSWORD=test\nTENVYR_VERSION=${current}\nTENVYR_SOURCE_REVISION=${sha}\nTENVYR_SELF_HOSTED_PREFIX=${prefix}\nTENVYR_POSTGRES_VOLUME=recovery_e2e_postgres_data\nTENVYR_POSTGRES_PORT=55440\nTENVYR_ORCHESTRATOR_PORT=53011\nTENVYR_GATEWAY_PORT=53010\nHTTP_AGENT_CALLBACK_BASE_URL=http://127.0.0.1:53011\nHTTP_AGENT_CALLBACK_KEYS={}\nHTTP_AGENT_ALLOW_INSECURE=true\n`,
  );
  writeFileSync(
    baseline,
    `services:\n  orchestrator:\n    build:\n      dockerfile: services/orchestrator/Dockerfile\n      target: production\n    healthcheck:\n      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3001/health | grep -q ready"]\n  gateway:\n    build:\n      dockerfile: services/gateway/Dockerfile\n      target: production\n    healthcheck:\n      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health | grep -q UP"]\nvolumes:\n  upgrade_check_data:\n`,
  );
  ok("docker", [...compose, "-f", baseline, "build"]);
  created = true;
  ok("docker", [...compose, "-f", baseline, "up", "-d"]);
  await ready();
  const originalProcess = ok("docker", [
    "top",
    `${prefix}-orchestrator`,
    "-eo", "pid,args",
  ]);
  assert.match(originalProcess, /node /);
  const pipeline = (
    await api("/pipelines", {
      name: "before-java-cutover",
      steps: [
        {
          id: "proof",
          agent: "unconfigured-proof-agent",
          input: { preserved: "é☃" },
        },
      ],
    })
  ).data;
  const execution = (await api("/executions", { pipelineId: pipeline.id }))
    .data;
  let status;
  for (let i = 0; i < 30; i++) {
    status = (await api(`/executions/${execution.id}`)).data.status;
    if (["FAILED", "COMPLETED", "CANCELLED"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(
    ["FAILED", "COMPLETED", "CANCELLED"].includes(status),
    "original authority execution settled before snapshot comparison",
  );
  const before = await api(`/workbench/executions/${execution.id}/capsule`);
  const ledger = sql("SELECT json_agg(m ORDER BY id) FROM migrations m");
  const plans = sql(
    "SELECT json_agg(p ORDER BY id) FROM execution_plan_revisions p",
  );
  console.log(
    "Original Node deployment seeded: migrations, execution, frozen plans and capsule",
  );
  // The checked-in launcher runs the built Java classes, while operations owns the clean clone.
  const result = ok("sh", [
    join(root, "scripts/java-backend.sh"),
    "operations",
    "upgrade",
    target,
  ]);
  process.stdout.write(result);
  assert.match(result, /verified backup and proven running source identity/);
  await ready();
  assert.equal(
    sql("SELECT json_agg(m ORDER BY id) FROM migrations m"),
    ledger,
    "the original TypeORM ledger is untouched",
  );
  assert.equal(
    sql("SELECT json_agg(p ORDER BY id) FROM execution_plan_revisions p"),
    plans,
    "frozen plans and persisted hashes survive the language cutover",
  );
  const after = await api(`/workbench/executions/${execution.id}/capsule`);
  assert.deepEqual(
    after.capsule,
    before.capsule,
    "original execution capsule and hash survive the upgrade exactly",
  );
  const metadata = readFileSync(deploy, "utf8");
  assert.ok(
    metadata.includes(`TENVYR_VERSION=${target}\n`) &&
      metadata.includes(`TENVYR_SOURCE_REVISION=${sha}\n`),
  );
  const manifests = readdirSync(maintenance).filter((name) =>
    name.endsWith(".manifest.json"),
  );
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(
    readFileSync(join(maintenance, manifests[0]), "utf8"),
  );
  assert.equal(manifest.verified, true);
  assert.equal(manifest.version, current);
  for (const service of ["orchestrator", "gateway"]) {
    assert.match(
      ok("docker", ["top", `${prefix}-${service}`, "-eo", "pid,args"]),
      /java .*io\.tenvyr\./,
    );
    assert.ok(
      [1, 127].includes(
        run("docker", [
          "exec",
          `${prefix}-${service}`,
          "sh",
          "-c",
          "command -v node",
        ]).status,
      ),
    );
  }
  const newPipeline = (
    await api("/pipelines", {
      name: "after-java-cutover",
      steps: [{ id: "proof", agent: "proof-agent", input: {} }],
    })
  ).data;
  assert.ok(newPipeline.id, "new writes work after cutover");
  console.log(
    `Verified original-to-Java upgrade PASS: backup, unchanged ledger/plans/capsule, new writes, Java-only processes and source ${sha}`,
  );
} catch (error) {
  if (created)
    process.stderr.write(
      run("docker", [...compose, "logs", "--tail", "60", "--no-color"])
        .stdout || "",
    );
  throw error;
} finally {
  if (created) {
    const result = run("docker", [...compose, "-f", baseline, "down", "-v"]);
    assert.equal(result.status, 0, "disposable upgrade stack cleanup");
  }
  rmSync(directory, { recursive: true, force: true });
}
