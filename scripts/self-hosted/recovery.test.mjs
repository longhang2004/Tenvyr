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
    // Hygiene: a crashed test could leave the durable recovery journal or
    // a stale maintenance lock behind — both are disposable test state.
    try {
      rmSync(join(ROOT, "backups", ".recovery-journal.json"), { force: true });
      rmSync(join(ROOT, "backups", ".maintenance.lock"), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
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
    // The fail-closed contract rejects the corrupt artifact (checksum
    // mismatch when a checksum authority exists, otherwise the missing
    // verified manifest) — always BEFORE quiescing.
    assert.match(corruptResult.stdout + corruptResult.stderr, /refusing to restore/);
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

  it("F1: crash after the first rename — the next invocation reconciles and restores the original authority", () => {
    const marker = createPipeline("crash-f1-state");
    assert.ok(marker, "crash-f1 pipeline did not persist");
    const { dumpPath } = takeBackup();
    // Abrupt termination AFTER tenvyr -> tenvyr_pre_restore and BEFORE the
    // second rename (SIGKILL — no cleanup can run).
    const crashed = promote(dumpPath, "crash-after-first-rename");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    const journalPath = join(ROOT, "backups", ".recovery-journal.json");
    // The durable journal + database names record the interrupted state.
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.phase, "swap-verified-to-active");
    let dbs = databases();
    assert.ok(!dbs.includes("tenvyr"), "tenvyr must be absent after the first-rename crash");
    assert.ok(dbs.includes("tenvyr_pre_restore"), "the ORIGINAL authority must be preserved as tenvyr_pre_restore");
    assert.ok(dbs.includes("tenvyr_restore"), "the verified candidate must be preserved");
    // The next recovery invocation reconciles BEFORE any destructive step.
    const next = promote(dumpPath);
    assert.notEqual(next.status, 0, "a promotion that reconciles an interruption must abort (retry required)");
    const output = next.stdout + next.stderr;
    assert.match(output, /interrupted promotion reconciled/);
    assert.match(output, /restored from the safety copy/);
    assert.match(output, /never dropped/);
    dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "tenvyr must be active again after reconciliation");
    assert.ok(!dbs.includes("tenvyr_pre_restore"), "the safety copy was consumed by the rename-back, not dropped");
    assert.ok(pipelines().includes("crash-f1-state"), "the ORIGINAL marker data must be present (never deleted)");
    assertServicesReady("after first-rename crash reconciliation");
    const postRecovery = createPipeline("crash-f1-recovery-write");
    assert.ok(postRecovery, "new write after reconciliation must succeed");
  });

  it("F2: crash after candidate promotion — the unproven candidate is never mistaken for a committed recovery", () => {
    const marker = createPipeline("crash-f2-state");
    assert.ok(marker, "crash-f2 pipeline did not persist");
    const { dumpPath } = takeBackup();
    // Abrupt termination AFTER tenvyr_restore -> tenvyr (candidate active)
    // but BEFORE the post-promotion gates complete.
    const crashed = promote(dumpPath, "crash-after-promotion");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    let dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "the candidate is active after the promotion rename");
    assert.ok(dbs.includes("tenvyr_pre_restore"), "the ORIGINAL authority must still be preserved");
    // The next invocation must NOT treat the candidate as committed and
    // must NOT silently delete the original safety copy.
    const next = promote(dumpPath);
    assert.notEqual(next.status, 0, "a promotion that reconciles an interruption must abort (retry required)");
    const output = next.stdout + next.stderr;
    assert.match(output, /interrupted promotion reconciled/);
    assert.match(output, /unproven candidate was preserved/);
    dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "tenvyr must be active again after reconciliation");
    assert.ok(dbs.includes("tenvyr_failed_promotion"), "the unproven candidate must be preserved as tenvyr_failed_promotion");
    assert.ok(!dbs.includes("tenvyr_pre_restore"), "the safety copy was consumed by the rename-back, not dropped");
    assert.ok(pipelines().includes("crash-f2-state"), "the ORIGINAL marker data must be present (never deleted)");
    assertServicesReady("after candidate-promotion crash reconciliation");
    const postRecovery = createPipeline("crash-f2-recovery-write");
    assert.ok(postRecovery, "new write after reconciliation must succeed");
  });

  it("F3: concurrent backups — exactly one owns the maintenance lock; the PASSing artifact drills PASS", async () => {
    // Two backups with deliberate overlap: the exclusive maintenance lock
    // serializes them (one PASS, one deterministic fail-fast), so no
    // corrupt artifact can ever be labeled PASS.
    const first = runAsync(process.execPath, ["scripts/self-hosted/backup.mjs"]);
    const second = runAsync(process.execPath, ["scripts/self-hosted/backup.mjs"]);
    const results = await Promise.all([first, second]);
    const passed = results.filter((result) => result.status === 0);
    const failed = results.filter((result) => result.status !== 0);
    assert.equal(passed.length, 1, `exactly one backup must PASS, got ${passed.length}`);
    assert.equal(failed.length, 1, `exactly one backup must fail, got ${failed.length}`);
    assert.match(failed[0].output, /maintenance operation already active/);
    const match = passed[0].output.match(/\[backup\] PASS (\S+\.dump)/);
    assert.ok(match, "the PASSing backup must name its dump");
    const dumpPath = match[1];
    createdBackups.push(dumpPath, `${dumpPath}.sha256`, dumpPath.replace(/\.dump$/, ".manifest.json"));
    // The invariant: a backup that prints PASS drills PASS immediately.
    const drillResult = drill(dumpPath);
    assert.equal(drillResult.status, 0, `drill of the PASSing concurrent backup failed: ${drillResult.stdout}\n${drillResult.stderr}`);
    assert.match(drillResult.stdout, /DRILL PASS/);
  });

  it("F4: concurrent promotions — only one may enter authority mutation; the second fails fast", async () => {
    const marker = createPipeline("crash-f4-state");
    assert.ok(marker, "crash-f4 pipeline did not persist");
    const { dumpPath } = takeBackup();
    const first = runAsync(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--promote"]);
    // The second promote starts while the first holds the maintenance
    // lock: it must fail fast BEFORE touching any database name.
    await sleep(2_000);
    const second = run(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--promote"], {
      timeout: 120_000,
    });
    assert.notEqual(second.status, 0, "the overlapping promotion must fail");
    assert.match(second.stdout + second.stderr, /maintenance operation already active/);
    // The first promotion completes its full recovery.
    const firstResult = await first;
    assert.equal(firstResult.status, 0, `the first promotion must complete: ${firstResult.output}`);
    assert.match(firstResult.output, /PASS: verified backup promoted/);
    assert.ok(pipelines().includes("crash-f4-state"), "the promoted authority must hold the marker data");
    assertServicesReady("after concurrent-promotion serialization");
  });

  it("F5: manifest contract fails closed before quiescing (required anchor null + checksum triple mismatch)", () => {
    const marker = createPipeline("crash-f5-state");
    assert.ok(marker, "crash-f5 pipeline did not persist");
    const { dumpPath } = takeBackup();
    const manifestPath = dumpPath.replace(/\.dump$/, ".manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // F5a: a required structural anchor is null -> contract failure BEFORE
    // quiescing (the original services + authority stay healthy).
    const nullAnchorManifest = {
      ...manifest,
      anchors: { ...manifest.anchors, planRevisionHashFingerprint: null },
    };
    writeFileSync(manifestPath, JSON.stringify(nullAnchorManifest, null, 2));
    const nullAnchorResult = promote(dumpPath);
    assert.notEqual(nullAnchorResult.status, 0, "null required anchor must fail promotion");
    assert.match(nullAnchorResult.stdout + nullAnchorResult.stderr, /required anchor "planRevisionHashFingerprint" is missing or malformed/);
    assert.ok(
      !(nullAnchorResult.stdout + nullAnchorResult.stderr).includes("stopping orchestrator"),
      "contract validation must happen BEFORE quiescing",
    );
    assertServicesReady("after null-anchor promote attempt");
    assert.ok(pipelines().includes("crash-f5-state"), "original authority must be untouched");

    // F5b: manifest.checksum disagrees with the dump/.sha256 -> checksum
    // triple mismatch BEFORE quiescing.
    const tamperedChecksumManifest = {
      ...manifest,
      checksum: "0".repeat(64),
    };
    writeFileSync(manifestPath, JSON.stringify(tamperedChecksumManifest, null, 2));
    const checksumResult = promote(dumpPath);
    assert.notEqual(checksumResult.status, 0, "checksum triple mismatch must fail promotion");
    assert.match(checksumResult.stdout + checksumResult.stderr, /checksum mismatch/);
    assert.ok(
      !(checksumResult.stdout + checksumResult.stderr).includes("stopping orchestrator"),
      "checksum validation must happen BEFORE quiescing",
    );
    assertServicesReady("after checksum-mismatch promote attempt");
    assert.ok(pipelines().includes("crash-f5-state"), "original authority must be untouched after F5b");

    // F5c: the manifest checksum is REQUIRED — deleting the field fails
    // closed BEFORE quiescing.
    const { checksum: _removed, ...withoutChecksum } = manifest;
    writeFileSync(manifestPath, JSON.stringify(withoutChecksum, null, 2));
    const missingChecksumResult = promote(dumpPath);
    assert.notEqual(missingChecksumResult.status, 0, "missing manifest checksum must fail promotion");
    assert.match(missingChecksumResult.stdout + missingChecksumResult.stderr, /manifest checksum is missing or malformed/);
    assert.ok(
      !(missingChecksumResult.stdout + missingChecksumResult.stderr).includes("stopping orchestrator"),
      "checksum-contract validation must happen BEFORE quiescing",
    );
    assertServicesReady("after missing-checksum promote attempt");
    assert.ok(pipelines().includes("crash-f5-state"), "original authority must be untouched after F5c");
    // Restore the honest manifest.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  });

  it("F6: malformed journal after the first rename — conservative reconciliation restores the original, never drops safety", () => {
    const marker = createPipeline("crash-f6-state");
    assert.ok(marker, "crash-f6 pipeline did not persist");
    const { dumpPath } = takeBackup();
    // Produce the interrupted state with a REAL crash, then corrupt the
    // durable journal evidence (truncated/malformed write).
    const crashed = promote(dumpPath, "crash-after-first-rename");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    const journalPath = join(ROOT, "backups", ".recovery-journal.json");
    writeFileSync(journalPath, "{truncated garbage", "utf8");
    let dbs = databases();
    assert.ok(!dbs.includes("tenvyr"), "tenvyr must be absent after the first-rename crash");
    assert.ok(dbs.includes("tenvyr_pre_restore"), "the ORIGINAL authority must be preserved as tenvyr_pre_restore");
    // The next invocation must NOT proceed destructively: the original
    // under the safety name is restored (renamed back, NEVER dropped).
    const next = promote(dumpPath);
    assert.notEqual(next.status, 0, "a promotion that reconciles an interruption must abort (retry required)");
    const output = next.stdout + next.stderr;
    assert.match(output, /interrupted promotion reconciled/);
    assert.match(output, /restored from the safety copy/);
    assert.match(output, /never dropped/);
    dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "tenvyr must be active again after reconciliation");
    assert.ok(!dbs.includes("tenvyr_pre_restore"), "the safety copy was consumed by the rename-back, not dropped");
    assert.ok(pipelines().includes("crash-f6-state"), "the ORIGINAL marker data must be present (never deleted)");
    assertServicesReady("after malformed-journal reconciliation");
    const postRecovery = createPipeline("crash-f6-recovery-write");
    assert.ok(postRecovery, "new write after reconciliation must succeed");
  });

  it("F7: missing journal after the first rename — no destructive proceed, original restored", () => {
    const marker = createPipeline("crash-f7-state");
    assert.ok(marker, "crash-f7 pipeline did not persist");
    const { dumpPath } = takeBackup();
    const crashed = promote(dumpPath, "crash-after-first-rename");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    // Remove the journal entirely (as if the write never landed).
    const journalPath = join(ROOT, "backups", ".recovery-journal.json");
    rmSync(journalPath, { force: true });
    let dbs = databases();
    assert.ok(!dbs.includes("tenvyr"), "tenvyr must be absent after the first-rename crash");
    assert.ok(dbs.includes("tenvyr_pre_restore"), "the ORIGINAL authority must be preserved as tenvyr_pre_restore");
    const next = promote(dumpPath);
    assert.notEqual(next.status, 0, "a promotion that reconciles an interruption must abort (retry required)");
    const output = next.stdout + next.stderr;
    assert.match(output, /interrupted promotion reconciled/);
    assert.match(output, /restored from the safety copy/);
    dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "tenvyr must be active again after reconciliation");
    assert.ok(!dbs.includes("tenvyr_pre_restore"), "the safety copy was consumed by the rename-back, not dropped");
    assert.ok(pipelines().includes("crash-f7-state"), "the ORIGINAL marker data must be present (never deleted)");
    assertServicesReady("after missing-journal reconciliation");
    const postRecovery = createPipeline("crash-f7-recovery-write");
    assert.ok(postRecovery, "new write after reconciliation must succeed");
  });

  it("F8: malformed journal after candidate promotion — ambiguous state FAILS CLOSED; both copies preserved; printed commands repair", () => {
    const marker = createPipeline("crash-f8-state");
    assert.ok(marker, "crash-f8 pipeline did not persist");
    const { dumpPath } = takeBackup();
    const crashed = promote(dumpPath, "crash-after-promotion");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    // Corrupt the journal: the layout (active candidate + original safety)
    // becomes ambiguous — the next invocation must FAIL CLOSED, never
    // treat the candidate as committed and never delete the original.
    const journalPath = join(ROOT, "backups", ".recovery-journal.json");
    writeFileSync(journalPath, "{truncated garbage", "utf8");
    let dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "the candidate is active after the promotion rename");
    assert.ok(dbs.includes("tenvyr_pre_restore"), "the ORIGINAL authority must still be preserved");
    const next = promote(dumpPath);
    assert.notEqual(next.status, 0, "an ambiguous state must fail closed");
    const output = next.stdout + next.stderr;
    assert.match(output, /CRITICAL/);
    assert.match(output, /no safe automatic reconciliation exists/);
    assert.match(output, /the active database is the unproven restored candidate; preserve it first/);
    // Both database copies are preserved — nothing was dropped.
    dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "the ambiguous active copy must be preserved");
    assert.ok(dbs.includes("tenvyr_pre_restore"), "the ORIGINAL safety copy must be preserved");
    // Execute the EXACT printed recovery commands (preserve the candidate
    // under the bounded failed name, restore the original) and restart.
    const preserve = psql("ALTER DATABASE tenvyr RENAME TO tenvyr_failed_promotion", "postgres");
    assert.equal(preserve.status, 0, `printed preserve command failed: ${preserve.stderr}`);
    const restoreOriginal = psql("ALTER DATABASE tenvyr_pre_restore RENAME TO tenvyr", "postgres");
    assert.equal(restoreOriginal.status, 0, `printed restore command failed: ${restoreOriginal.stderr}`);
    runOk("docker", [...COMPOSE.slice(1), "start", "orchestrator", "gateway"], { timeout: 120_000 });
    assertServicesReady("after executing the printed recovery commands");
    assert.ok(pipelines().includes("crash-f8-state"), "the ORIGINAL marker data must be present");
    assert.ok(dbs.includes("tenvyr_failed_promotion") || databases().includes("tenvyr_failed_promotion"), "the unproven candidate must be preserved");
    // The malformed journal on the now-clean layout is cleared by
    // --reconcile.
    const reconcile = run(process.execPath, ["scripts/self-hosted/restore.mjs", "--reconcile"], {
      timeout: 120_000,
    });
    assert.equal(reconcile.status, 0, `--reconcile must exit clean: ${reconcile.stdout}\n${reconcile.stderr}`);
    assert.ok(!existsSync(journalPath), "the malformed journal must be cleared on the clean layout");
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
    // The durable journal still records the interrupted promotion; the
    // explicit --reconcile mode clears it and proves the state is clean.
    const reconcile = run(process.execPath, ["scripts/self-hosted/restore.mjs", "--reconcile"], {
      timeout: 120_000,
    });
    assert.equal(reconcile.status, 0, `--reconcile must exit clean: ${reconcile.stdout}\n${reconcile.stderr}`);
    assert.match(reconcile.stdout, /no interrupted promotion detected|reconciled/);
    assert.ok(!existsSync(join(ROOT, "backups", ".recovery-journal.json")), "the recovery journal must be cleared");
  });
});
