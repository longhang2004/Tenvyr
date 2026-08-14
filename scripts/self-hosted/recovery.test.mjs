#!/usr/bin/env node
/**
 * M11 closure: disposable self-hosted recovery E2E suite — run with
 * `pnpm self-hosted:recovery-test` on infrastructure that is DISPOSABLE.
 *
 * One throwaway stack (postgres + orchestrator + gateway) is brought up in
 * `before` and torn down in `after` (containers, volumes, temp DBs, deploy
 * env, and backup artifacts are cleaned unconditionally). The suite needs
 * no Codex/Claude/OpenCode credentials and never touches real operator
 * deployment state.
 *
 * Tests:
 *   A. Concurrent-write backup consistency: writes race backup creation;
 *      a backup that reports PASS must pass an immediate drill of that
 *      exact artifact.
 *   B. Historical recovery: state A -> backup A -> live B -> drill A PASS
 *      -> promote A -> B absent -> readiness -> new write succeeds.
 *   C. Invalid backup promotion safety: malformed/corrupt/manifest-
 *      inconsistent backups FAIL promotion BEFORE service quiescing; the
 *      original DB stays active and the services stay ready.
 *   D. Rename failure fault injection: the `verified -> active` rename is
 *      faulted (TENVYR_RESTORE_FAULT=second-rename); the swap state
 *      machine automatically rolls `tenvyr_pre_restore` back to active
 *      and the original deployment becomes healthy again.
 *   E. Post-promotion failure: the orchestrator-readiness gate is faulted
 *      after the restored DB became active; rollback restores the
 *      original authority while the safety copy is still available.
 *   D2. Rollback-rename fault: both the second rename AND the rollback
 *      rename are faulted; restore prints the exact observed state and
 *      bounded recovery commands and never claims success — and the
 *      printed commands, executed by the test, repair the deployment.
 *
 * SAFETY — refuses to run when real infrastructure is present: any
 * tenvyr-self-hosted-* container (a real deployment would be using it) or
 * a leftover preserved deploy.env from a crashed run.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_ENV = join(ROOT, "deploy.env");
const SAVED_DEPLOY_ENV = `${DEPLOY_ENV}.recovery-test-saved`;
const COMPOSE = [
  "docker",
  "compose",
  "-f",
  "docker-compose.self-hosted.yml",
  "--env-file",
  DEPLOY_ENV,
];
const TARGET = "v0.1.0";
const DISPOSABLE_SHA = "a".repeat(40);

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 600_000, ...opts });

const runOk = (cmd, args, opts = {}) => {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? result.stdout ?? "").slice(0, 2000)}`,
    );
  }
  return result;
};

const runAsync = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, ...opts });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => resolve({ status: code, output }));
    child.on("error", (error) => resolve({ status: -1, output: String(error) }));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dockerPs = () =>
  run("docker", ["ps", "--format", "{{.Names}}"], { timeout: 30_000 }).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const waitForHealth = (url, expected, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = run("curl", ["-s", url], { timeout: 5_000 });
    if (probe.status === 0 && probe.stdout.includes(expected)) return true;
    const sleepUntil = Date.now() + 1_000;
    while (Date.now() < sleepUntil) {
      // synchronous CLI sleep
    }
  }
  return false;
};

const postJson = (url, body) => {
  const result = run(
    "curl",
    ["-s", "-X", "POST", url, "-H", "Content-Type: application/json", "-d", JSON.stringify(body)],
    { timeout: 30_000 },
  );
  if (result.status !== 0) throw new Error(`POST ${url} failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  return parsed?.data?.id ?? parsed?.id ?? null;
};

const psql = (sql, db = "tenvyr") =>
  run("docker", ["exec", "tenvyr-self-hosted-postgres", "psql", "-U", "tenvyr", "-d", db, "-tA", "-c", sql], {
    timeout: 60_000,
  });

const databases = () =>
  psql("SELECT datname FROM pg_database ORDER BY datname", "postgres").stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const pipelines = () =>
  psql("SELECT name FROM pipelines ORDER BY name").stdout.trim().split("\n").filter(Boolean);

describe("self-hosted recovery E2E (disposable infrastructure)", { timeout: 2_400_000 }, () => {
  let createdBackups = [];
  let preExistingDeployEnv = null;
  let disposableDeployEnvWritten = false;

  before(() => {
    // ---- SAFETY GUARDS: disposable infrastructure only ----
    const names = dockerPs();
    for (const name of names) {
      assert.ok(
        !name.startsWith("tenvyr-self-hosted-"),
        `refusing to run: container "${name}" exists (a real self-hosted deployment is using the infrastructure)`,
      );
    }
    assert.ok(
      !process.env.TENVYR_DEPLOY_ENV,
      "refusing to run: TENVYR_DEPLOY_ENV is set (this test owns ROOT/deploy.env)",
    );
    assert.ok(
      !existsSync(SAVED_DEPLOY_ENV),
      `refusing to run: ${SAVED_DEPLOY_ENV} already exists (a previous run's preserved deploy.env was never restored)`,
    );
    let deployEnvExists = false;
    try {
      readFileSync(DEPLOY_ENV, "utf8");
      deployEnvExists = true;
    } catch {
      deployEnvExists = false;
    }
    if (deployEnvExists) {
      preExistingDeployEnv = readFileSync(DEPLOY_ENV, "utf8");
      if (!preExistingDeployEnv.includes("DISPOSABLE — created by recovery.test.mjs")) {
        // Preserve a pre-existing (operator or prior-drill) deploy.env and
        // restore it in teardown — the test only ever writes its own marked,
        // disposable file.
        writeFileSync(SAVED_DEPLOY_ENV, preExistingDeployEnv);
      }
    }

    // ---- disposable deploy.env (marked, removed in teardown) ----
    const example = readFileSync(join(ROOT, ".env.self-hosted.example"), "utf8")
      .split("\n")
      // The appended values below are authoritative — drop the example's
      // empty identity placeholders to avoid env-file duplicate semantics.
      .filter((line) => !/^TENVYR_VERSION=/.test(line) && !/^TENVYR_SOURCE_REVISION=/.test(line))
      .join("\n");
    const disposable = `# DISPOSABLE — created by recovery.test.mjs; safe to delete
${example}
POSTGRES_PASSWORD=test
TENVYR_VERSION=${TARGET}
TENVYR_SOURCE_REVISION=${DISPOSABLE_SHA}
`;
    writeFileSync(DEPLOY_ENV, disposable);
    disposableDeployEnvWritten = true;

    // ---- build (only if missing) + start the disposable stack ----
    const needsBuild = ["tenvyr-orchestrator", "tenvyr-gateway"].some(
      (image) => run("docker", ["image", "inspect", `${image}:${TARGET}`], { timeout: 30_000 }).status !== 0,
    );
    if (needsBuild) {
      runOk("docker", [...COMPOSE.slice(1), "build"], { timeout: 1_200_000 });
    }
    runOk("docker", [...COMPOSE.slice(1), "up", "-d"], { timeout: 300_000 });
    assert.ok(
      waitForHealth("http://127.0.0.1:3001/health", '"ready":true'),
      "orchestrator did not become ready (migrations must have applied)",
    );
    assert.ok(waitForHealth("http://127.0.0.1:3000/health", "UP"), "gateway did not become ready");
  });

  after(() => {
    // ---- TEARDOWN (disposable infrastructure only), always runs ----
    run("docker", [...COMPOSE.slice(1), "down", "-v"], { timeout: 300_000 });
    for (const file of createdBackups) {
      try {
        rmSync(file, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    if (disposableDeployEnvWritten) {
      try {
        const text = readFileSync(DEPLOY_ENV, "utf8");
        if (text.includes("DISPOSABLE — created by recovery.test.mjs")) {
          rmSync(DEPLOY_ENV, { force: true });
        }
      } catch {
        // best-effort cleanup
      }
    }
    // Restore any pre-existing deploy.env the test preserved.
    if (preExistingDeployEnv !== null) {
      try {
        if (!existsSync(DEPLOY_ENV)) {
          writeFileSync(DEPLOY_ENV, preExistingDeployEnv);
        }
        rmSync(SAVED_DEPLOY_ENV, { force: true });
      } catch {
        // best-effort cleanup; the preserved copy remains at
        // deploy.env.recovery-test-saved
      }
    }
  });

  /** Runs backup.mjs and returns { dumpPath, output } of the VERIFIED artifact. */
  const takeBackup = () => {
    const result = runOk(process.execPath, ["scripts/self-hosted/backup.mjs"], { timeout: 300_000 });
    const match = result.stdout.match(/\[backup\] PASS (\S+\.dump)/);
    assert.ok(match, `backup did not report a PASS dump path: ${result.stdout}`);
    const dumpPath = match[1];
    createdBackups.push(dumpPath, `${dumpPath}.sha256`, dumpPath.replace(/\.dump$/, ".manifest.json"));
    return { dumpPath, output: result.stdout };
  };

  const drill = (dumpPath) =>
    run(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--drill"], { timeout: 600_000 });

  const promote = (dumpPath, faultLabels = "") =>
    run(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--promote"], {
      timeout: 900_000,
      env: {
        ...process.env,
        ...(faultLabels ? { TENVYR_RESTORE_FAULT: faultLabels } : {}),
      },
    });

  const createPipeline = (name) =>
    postJson("http://127.0.0.1:3001/pipelines", {
      name,
      version: "1.0",
      steps: [{ id: "step", agent: "agent", input: {}, dependsOn: [] }],
    });

  const assertServicesReady = (context) => {
    assert.ok(
      waitForHealth("http://127.0.0.1:3001/health", '"ready":true'),
      `${context}: orchestrator not ready`,
    );
    assert.ok(waitForHealth("http://127.0.0.1:3000/health", "UP"), `${context}: gateway not ready`);
  };

  it("A: concurrent writes during backup creation never break the backup-drill invariant", async () => {
    // Writes race the backup for its whole duration (dump -> isolated
    // restore -> anchors -> finalize). A PASS must imply an immediate
    // drill of that exact artifact PASSes.
    const backupPromise = runAsync(process.execPath, ["scripts/self-hosted/backup.mjs"]);
    let backupDone = false;
    backupPromise.then(() => {
      backupDone = true;
    });
    let writes = 0;
    for (let i = 0; i < 60 && !backupDone; i += 1) {
      try {
        createPipeline(`race-write-${writes}`);
        writes += 1;
      } catch {
        // a write racing the backup may transiently fail; the backup
        // invariant is what matters
      }
      await sleep(200);
    }
    const backupResult = await backupPromise;
    assert.equal(backupResult.status, 0, `backup failed under concurrent writes: ${backupResult.output}`);
    assert.ok(writes > 0, "expected at least one concurrent write during backup");
    const match = backupResult.output.match(/\[backup\] PASS (\S+\.dump)/);
    assert.ok(match, "backup PASS must name the dump path");
    const dumpPath = match[1];
    createdBackups.push(dumpPath, `${dumpPath}.sha256`, dumpPath.replace(/\.dump$/, ".manifest.json"));
    const drillResult = drill(dumpPath);
    assert.equal(drillResult.status, 0, `drill of the PASSed backup failed: ${drillResult.stdout}\n${drillResult.stderr}`);
    assert.match(drillResult.stdout, /DRILL PASS/);
  });

  it("B: historical recovery — backup A, advance live to B, drill+promote A, B absent, new write succeeds", () => {
    // 1. STATE A
    const pipelineA = createPipeline("recovery-state-A");
    assert.ok(pipelineA, "state A pipeline did not persist");
    const executionA = postJson("http://127.0.0.1:3001/executions", { pipelineId: pipelineA });
    assert.ok(executionA, "state A execution did not persist");
    // 2. BACKUP A (VERIFIED by construction)
    const { dumpPath } = takeBackup();
    // 3. MUTATE the live database with legitimate state B
    const pipelineB = createPipeline("recovery-state-B");
    assert.ok(pipelineB, "state B pipeline did not persist");
    const executionB = postJson("http://127.0.0.1:3001/executions", { pipelineId: pipelineB });
    assert.ok(executionB, "state B execution did not persist");
    // 4. DRILL of A: must PASS despite A != current B
    const drillResult = drill(dumpPath);
    assert.equal(drillResult.status, 0, `drill of backup A failed: ${drillResult.stdout}\n${drillResult.stderr}`);
    assert.match(drillResult.stdout, /DRILL PASS/);
    assert.match(drillResult.stdout, /informational only|info:/);
    // 5. PROMOTE A
    const promoteResult = promote(dumpPath);
    assert.equal(promoteResult.status, 0, `promote failed: ${promoteResult.stdout}\n${promoteResult.stderr}`);
    assert.match(promoteResult.stdout, /PASS: verified backup promoted/);
    // 6. PROVE the promoted authority is exactly snapshot A (the restore
    //    write proof adds one pipeline + execution)
    const names = pipelines();
    assert.ok(names.includes("recovery-state-A"), `promoted DB must contain snapshot A, got: ${names.join(", ")}`);
    assert.ok(!names.includes("recovery-state-B"), `post-backup state B must NOT survive promotion, got: ${names.join(", ")}`);
    // 7. readiness + new post-recovery write
    assertServicesReady("after promotion");
    const postRecovery = createPipeline("post-recovery-write");
    assert.ok(postRecovery, "post-recovery write did not persist");
    const postNames = pipelines();
    assert.ok(postNames.includes("post-recovery-write"), `new write missing: ${postNames.join(", ")}`);
  });

  it("C: invalid backup promotion fails BEFORE quiescing and leaves the deployment untouched", () => {
    const marker = createPipeline("invalid-backup-marker");
    assert.ok(marker, "marker pipeline did not persist");
    const { dumpPath } = takeBackup();
    const manifestPath = dumpPath.replace(/\.dump$/, ".manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // C1: corrupt dump bytes -> checksum mismatch (pre-quiesce failure).
    const corruptDump = `${dumpPath}.corrupt`;
    createdBackups.push(corruptDump);
    writeFileSync(corruptDump, `${readFileSync(dumpPath, "utf8")}CORRUPTED`);
    const corruptResult = promote(corruptDump);
    assert.notEqual(corruptResult.status, 0, "corrupt dump must fail promotion");
    assert.match(corruptResult.stdout + corruptResult.stderr, /checksum mismatch/);
    assert.ok(
      !(corruptResult.stdout + corruptResult.stderr).includes("stopping orchestrator"),
      "validation must happen BEFORE quiescing",
    );
    assertServicesReady("after corrupt-backup promote attempt");
    assert.ok(pipelines().includes("invalid-backup-marker"), "original authority must be untouched");

    // C2: manifest-inconsistent backup (anchors tampered; checksum valid)
    // -> deep verification fails before quiescing.
    const tamperedManifest = {
      ...manifest,
      anchors: { ...manifest.anchors, tableCountFingerprint: "0".repeat(64) },
    };
    writeFileSync(manifestPath, JSON.stringify(tamperedManifest, null, 2));
    const tamperedResult = promote(dumpPath);
    assert.notEqual(tamperedResult.status, 0, "manifest-inconsistent backup must fail promotion");
    assert.match(tamperedResult.stdout + tamperedResult.stderr, /tableCountFingerprint mismatch/);
    assert.ok(
      !(tamperedResult.stdout + tamperedResult.stderr).includes("stopping orchestrator"),
      "deep verification must happen BEFORE quiescing",
    );
    assertServicesReady("after manifest-inconsistent promote attempt");
    assert.ok(pipelines().includes("invalid-backup-marker"), "original authority must be untouched after C2");
    // Restore the honest manifest for any later use.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  });

  it("D: second-rename fault — automatic rollback restores the original authority", () => {
    const marker = createPipeline("fault-d-state");
    assert.ok(marker, "fault-d pipeline did not persist");
    const { dumpPath } = takeBackup();
    const result = promote(dumpPath, "second-rename");
    assert.notEqual(result.status, 0, "faulted promotion must fail");
    const output = result.stdout + result.stderr;
    assert.match(output, /automatic rollback restored the original authority/);
    // Original tenvyr is active again with the pre-promotion data.
    assert.ok(pipelines().includes("fault-d-state"), `original authority must be restored, got: ${pipelines().join(", ")}`);
    // Services healthy again.
    assertServicesReady("after second-rename rollback");
  });

  it("E: post-promotion gate fault — rollback to the original authority while the safety copy is available", () => {
    const marker = createPipeline("fault-e-state");
    assert.ok(marker, "fault-e pipeline did not persist");
    const { dumpPath } = takeBackup();
    const result = promote(dumpPath, "post-gate-readiness");
    assert.notEqual(result.status, 0, "faulted post-promotion gate must fail");
    const output = result.stdout + result.stderr;
    assert.match(output, /post-promotion gate failed/);
    assert.match(output, /automatic rollback restored the original authority/);
    assert.ok(pipelines().includes("fault-e-state"), `original authority must be restored, got: ${pipelines().join(", ")}`);
    // The bounded failed-promotion state is cleaned up after rollback.
    assert.ok(!databases().includes("tenvyr_failed_promotion"), "failed-promotion state must be cleaned up");
    assertServicesReady("after post-promotion rollback");
  });

  it("D2: rollback-rename fault — loud failure with exact recovery commands; the printed commands repair the deployment", () => {
    const marker = createPipeline("fault-d2-state");
    assert.ok(marker, "fault-d2 pipeline did not persist");
    const { dumpPath } = takeBackup();
    const result = promote(dumpPath, "second-rename,rollback-rename");
    assert.notEqual(result.status, 0, "double-faulted promotion must fail");
    const output = result.stdout + result.stderr;
    assert.match(output, /CRITICAL/);
    assert.match(output, /rollback failed/);
    assert.match(output, /recovery commands/);
    assert.match(output, /ALTER DATABASE tenvyr_pre_restore RENAME TO tenvyr/);
    // Observed state: the original authority is preserved under the safety
    // name and the verified candidate is preserved — nothing was deleted.
    const dbs = databases();
    assert.ok(dbs.includes("tenvyr_pre_restore"), "original authority must be preserved as tenvyr_pre_restore");
    assert.ok(dbs.includes("tenvyr_restore"), "verified candidate must be preserved");
    assert.ok(!dbs.includes("tenvyr"), "tenvyr must be absent in the rollback-failed state");
    // Execute the EXACT printed recovery command and restart services:
    // this proves the operator instructions are correct.
    const rename = psql("ALTER DATABASE tenvyr_pre_restore RENAME TO tenvyr", "postgres");
    assert.equal(rename.status, 0, `printed recovery command failed: ${rename.stderr}`);
    runOk("docker", [...COMPOSE.slice(1), "start", "orchestrator", "gateway"], { timeout: 120_000 });
    assertServicesReady("after executing the printed recovery commands");
    assert.ok(pipelines().includes("fault-d2-state"), `recovered authority must hold the original data, got: ${pipelines().join(", ")}`);
  });
});
