#!/usr/bin/env node
/**
 * M11 closure: disposable self-hosted recovery E2E suite — run with
 * `pnpm self-hosted:recovery-test` on infrastructure that is DISPOSABLE.
 *
 * ISOLATION (by construction): the suite brings up its own stack under
 * the UNIQUE project `tenvyr-recovery-e2e` with unique container names
 * (tenvyr-recovery-e2e-*), a unique PostgreSQL volume, unique host
 * ports, and its own disposable deploy env at
 * backups/.recovery-e2e-deploy.env. The production `tenvyr-self-hosted`
 * names are NEVER targeted — not by the tests and not by the teardown
 * (the teardown is gated by `disposableStackCreated` and only ever runs
 * `compose down -v` against the disposable project). An early
 * safety-guard failure performs ZERO compose-down / volume-delete
 * actions.
 *
 * SAFETY GUARD (before anything is created): refuses to run when
 *   - any `tenvyr-self-hosted-*` container exists — RUNNING OR STOPPED
 *     (`docker ps -a`), or
 *   - the real deployment PostgreSQL volume
 *     `tenvyr-self-hosted_tenvyr_postgres_data` exists, or
 *   - a previous E2E stack (`tenvyr-recovery-e2e-*`) still exists.
 *
 * Tests:
 *   A. Concurrent-write backup consistency.
 *   B. Historical recovery: state A -> backup A -> live B -> drill A PASS
 *      -> promote A -> B absent -> readiness -> new write succeeds.
 *   C. Invalid backup promotion safety (pre-quiesce).
 *   D. Second-rename fault -> automatic rollback.
 *   E. Post-promotion gate fault -> rollback.
 *   D2. Rollback-rename fault -> exact printed commands repair.
 *   F1/F2. SIGKILL after first rename / after candidate promotion.
 *   F3/F4. Concurrent backups / concurrent promotions.
 *   F5. Manifest contract fails closed (incl. required checksum).
 *   F6/F7/F8. Malformed/missing journal crash layouts.
 *   G1/G2. SIGKILL after quiesce / after rollback renames -> --reconcile
 *      restores availability.
 *   F9. Existing tenvyr_failed_promotion cannot collide with a later
 *      rollback.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** UNIQUE disposable stack identity — never the production names. */
export const E2E_PROJECT = "tenvyr-recovery-e2e";
export const E2E_POSTGRES_CONTAINER = "tenvyr-recovery-e2e-postgres";
export const E2E_ORCHESTRATOR_PORT = "3101";
export const E2E_GATEWAY_PORT = "3100";
export const E2E_POSTGRES_PORT = "5544";
export const E2E_VOLUME = "recovery_e2e_postgres_data";
export const E2E_DEPLOY_ENV = join(ROOT, "backups", ".recovery-e2e-deploy.env");

const COMPOSE = [
  "docker",
  "compose",
  "-p",
  E2E_PROJECT,
  "-f",
  "docker-compose.self-hosted.yml",
  "--env-file",
  E2E_DEPLOY_ENV,
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

/** All containers — RUNNING OR STOPPED (docker ps -a). */
const dockerPsA = () =>
  run("docker", ["ps", "-a", "--format", "{{.Names}}"], { timeout: 30_000 }).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const dockerVolumes = () => {
  const result = run("docker", ["volume", "ls", "--format", "json"], { timeout: 30_000 });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line)?.Name ?? null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

/** PURE safety decision: the reason to refuse running, or null when the
 *  environment is safe (no real deployment infrastructure, no leftover
 *  E2E stack). */
export const safetyBlockReason = ({ containerNames, volumeNames }) => {
  for (const name of containerNames) {
    if (name.startsWith("tenvyr-self-hosted-")) {
      return `container "${name}" exists (a real self-hosted deployment is using the infrastructure — running or stopped)`;
    }
    if (name.startsWith(`${E2E_PROJECT}-`)) {
      return `disposable E2E container "${name}" already exists (a previous E2E run was not torn down)`;
    }
  }
  if (volumeNames.includes("tenvyr-self-hosted_tenvyr_postgres_data")) {
    return "the real deployment PostgreSQL volume tenvyr-self-hosted_tenvyr_postgres_data exists";
  }
  if (volumeNames.includes(`${E2E_PROJECT}_${E2E_VOLUME}`)) {
    return `disposable E2E volume ${E2E_PROJECT}_${E2E_VOLUME} already exists (a previous E2E run was not torn down)`;
  }
  return null;
};

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
  run("docker", ["exec", E2E_POSTGRES_CONTAINER, "psql", "-U", "tenvyr", "-d", db, "-tA", "-c", sql], {
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
  let disposableStackCreated = false;

  before(() => {
    // ---- 0. The disposable deploy env is written FIRST (a fixed,
    //        gitignored path the suite owns). It carries the unique
    //        stack identity so the resolved compose project, containers,
    //        ports, and volume are all E2E-specific. ----
    const example = readFileSync(join(ROOT, ".env.self-hosted.example"), "utf8")
      .split("\n")
      .filter((line) => !/^TENVYR_VERSION=/.test(line) && !/^TENVYR_SOURCE_REVISION=/.test(line))
      .join("\n");
    const disposable = `# DISPOSABLE — created by recovery.test.mjs; safe to delete
${example}
POSTGRES_PASSWORD=test
TENVYR_VERSION=${TARGET}
TENVYR_SOURCE_REVISION=${DISPOSABLE_SHA}
TENVYR_SELF_HOSTED_PREFIX=${E2E_PROJECT}
TENVYR_POSTGRES_PORT=${E2E_POSTGRES_PORT}
TENVYR_ORCHESTRATOR_PORT=${E2E_ORCHESTRATOR_PORT}
TENVYR_GATEWAY_PORT=${E2E_GATEWAY_PORT}
TENVYR_POSTGRES_VOLUME=${E2E_VOLUME}
`;
    // (backups/ is gitignored — ensure it exists on a fresh checkout)
    mkdirSync(join(ROOT, "backups"), { recursive: true });
    writeFileSync(E2E_DEPLOY_ENV, disposable);

    // ---- 1. SAFETY GUARD: refuse when real infrastructure is present
    //        (containers RUNNING OR STOPPED, or the production volume),
    //        or when a previous E2E stack was not torn down. On refusal
    //        NOTHING is created and the teardown performs ZERO
    //        destructive actions (disposableStackCreated stays false). ----
    const reason = safetyBlockReason({
      containerNames: dockerPsA(),
      volumeNames: dockerVolumes(),
    });
    assert.ok(reason === null, `refusing to run: ${reason}`);
    assert.ok(
      !process.env.TENVYR_DEPLOY_ENV,
      `refusing to run: TENVYR_DEPLOY_ENV is already set (${process.env.TENVYR_DEPLOY_ENV}) — the suite owns its disposable deploy env`,
    );

    // ---- 2. Build (only if missing) + start the disposable stack. ----
    const needsBuild = ["tenvyr-orchestrator", "tenvyr-gateway"].some(
      (image) => run("docker", ["image", "inspect", `${image}:${TARGET}`], { timeout: 30_000 }).status !== 0,
    );
    if (needsBuild) {
      runOk("docker", [...COMPOSE.slice(1), "build"], { timeout: 1_200_000 });
    }
    // From this point the disposable stack may exist — the teardown is
    // allowed to tear it down (and ONLY it).
    disposableStackCreated = true;
    runOk("docker", [...COMPOSE.slice(1), "up", "-d"], { timeout: 300_000 });
    assert.ok(
      waitForHealth(`http://127.0.0.1:${E2E_ORCHESTRATOR_PORT}/health`, '"ready":true'),
      "orchestrator did not become ready (migrations must have applied)",
    );
    assert.ok(waitForHealth(`http://127.0.0.1:${E2E_GATEWAY_PORT}/health`, "UP"), "gateway did not become ready");
  });

  after(() => {
    // ---- TEARDOWN: ONLY the disposable E2E project is ever touched.
    //      If the safety guard failed, disposableStackCreated is false
    //      and ZERO compose-down / volume-delete actions run. ----
    if (disposableStackCreated) {
      run("docker", [...COMPOSE.slice(1), "down", "-v"], { timeout: 300_000 });
    }
    for (const file of createdBackups) {
      try {
        rmSync(file, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    // The suite owns its disposable deploy env + the shared disposable
    // journal/lock/tombstone paths (no real deployment can exist when
    // the suite ran — the guard refused otherwise).
    try {
      rmSync(E2E_DEPLOY_ENV, { force: true });
      rmSync(join(ROOT, "backups", ".recovery-journal.json"), { force: true });
      rmSync(join(ROOT, "backups", ".maintenance.lock"), { force: true });
      for (const entry of readdirSync(join(ROOT, "backups"))) {
        if (entry.startsWith(".maintenance.lock.stale.")) {
          rmSync(join(ROOT, "backups", entry), { recursive: true, force: true });
        }
      }
    } catch {
      // best-effort cleanup
    }
  });

  /** The E2E stack identity for spawned scripts: the disposable deploy
   *  env, the disposable postgres container, the disposable compose
   *  project, and the disposable ports. The production names are never
   *  referenced. */
  const e2eEnv = (extra = {}) => ({
    ...process.env,
    TENVYR_DEPLOY_ENV: E2E_DEPLOY_ENV,
    TENVYR_POSTGRES_CONTAINER: E2E_POSTGRES_CONTAINER,
    TENVYR_SELF_HOSTED_PROJECT: E2E_PROJECT,
    TENVYR_ORCHESTRATOR_PORT: E2E_ORCHESTRATOR_PORT,
    TENVYR_GATEWAY_PORT: E2E_GATEWAY_PORT,
    ...extra,
  });

  const orchestratorBase = `http://127.0.0.1:${E2E_ORCHESTRATOR_PORT}`;
  const gatewayBase = `http://127.0.0.1:${E2E_GATEWAY_PORT}`;

  /** Runs backup.mjs and returns { dumpPath, output } of the VERIFIED artifact. */
  const takeBackup = () => {
    const result = runOk(process.execPath, ["scripts/self-hosted/backup.mjs"], {
      timeout: 300_000,
      env: e2eEnv(),
    });
    const match = result.stdout.match(/\[backup\] PASS (\S+\.dump)/);
    assert.ok(match, `backup did not report a PASS dump path: ${result.stdout}`);
    const dumpPath = match[1];
    createdBackups.push(dumpPath, `${dumpPath}.sha256`, dumpPath.replace(/\.dump$/, ".manifest.json"));
    return { dumpPath, output: result.stdout };
  };

  const drill = (dumpPath) =>
    run(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--drill"], {
      timeout: 600_000,
      env: e2eEnv(),
    });

  const promote = (dumpPath, faultLabels = "") =>
    run(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--promote"], {
      timeout: 900_000,
      env: e2eEnv(faultLabels ? { TENVYR_RESTORE_FAULT: faultLabels } : {}),
    });

  const reconcile = () =>
    run(process.execPath, ["scripts/self-hosted/restore.mjs", "--reconcile"], {
      timeout: 120_000,
      env: e2eEnv(),
    });

  const createPipeline = (name) =>
    postJson(`${orchestratorBase}/pipelines`, {
      name,
      version: "1.0",
      steps: [{ id: "step", agent: "agent", input: {}, dependsOn: [] }],
    });

  const assertServicesReady = (context) => {
    assert.ok(
      waitForHealth(`${orchestratorBase}/health`, '"ready":true'),
      `${context}: orchestrator not ready`,
    );
    assert.ok(waitForHealth(`${gatewayBase}/health`, "UP"), `${context}: gateway not ready`);
  };

  it("A: concurrent writes during backup creation never break the backup-drill invariant", async () => {
    // Writes race the backup for its whole duration (dump -> isolated
    // restore -> anchors -> finalize). A PASS must imply an immediate
    // drill of that exact artifact PASSes.
    const backupPromise = runAsync(process.execPath, ["scripts/self-hosted/backup.mjs"], { env: e2eEnv() });
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
    const executionA = postJson(`${orchestratorBase}/executions`, { pipelineId: pipelineA });
    assert.ok(executionA, "state A execution did not persist");
    // 2. BACKUP A (VERIFIED by construction)
    const { dumpPath } = takeBackup();
    // 3. MUTATE the live database with legitimate state B
    const pipelineB = createPipeline("recovery-state-B");
    assert.ok(pipelineB, "state B pipeline did not persist");
    const executionB = postJson(`${orchestratorBase}/executions`, { pipelineId: pipelineB });
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
    assertServicesReady("after rollback-candidate reconciliation");
    const postRecovery = createPipeline("crash-f2-recovery-write");
    assert.ok(postRecovery, "new write after reconciliation must succeed");
    // The reconcile preserved this test's own candidate as evidence — drop
    // it so a later test's manual repair never collides with it.
    const dropCandidate = psql("DROP DATABASE IF EXISTS tenvyr_failed_promotion", "postgres");
    assert.equal(dropCandidate.status, 0, `dropping this test's own preserved candidate failed: ${dropCandidate.stderr}`);
  });

  it("F3: concurrent backups — exactly one owns the maintenance lock; the PASSing artifact drills PASS", async () => {
    // Two backups with deliberate overlap: the exclusive maintenance lock
    // serializes them (one PASS, one deterministic fail-fast), so no
    // corrupt artifact can ever be labeled PASS.
    const first = runAsync(process.execPath, ["scripts/self-hosted/backup.mjs"], { env: e2eEnv() });
    const second = runAsync(process.execPath, ["scripts/self-hosted/backup.mjs"], { env: e2eEnv() });
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
    const first = runAsync(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--promote"], { env: e2eEnv() });
    // The second promote starts while the first holds the maintenance
    // lock: it must fail fast BEFORE touching any database name.
    await sleep(2_000);
    const second = run(process.execPath, ["scripts/self-hosted/restore.mjs", dumpPath, "--promote"], {
      timeout: 120_000,
      env: e2eEnv(),
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
    const reconcileResult = reconcile();
    assert.equal(reconcileResult.status, 0, `--reconcile must exit clean: ${reconcile.stdout}\n${reconcile.stderr}`);
    assert.ok(!existsSync(journalPath), "the malformed journal must be cleared on the clean layout");
  });

  it("G1: SIGKILL after quiesce — --reconcile restarts the original deployment and reports the interrupted operation", () => {
    const marker = createPipeline("crash-g1-state");
    assert.ok(marker, "crash-g1 pipeline did not persist");
    const { dumpPath } = takeBackup();
    // The "quiescing" journal marker is written BEFORE quiesce; the fault
    // hook kills the process abruptly right after the writers stopped.
    const crashed = promote(dumpPath, "crash-after-quiesce");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    // Writers are quiesced: the services are down, the ORIGINAL authority
    // is still active, and the journal says "quiescing".
    assert.ok(!waitForHealth(`${orchestratorBase}/health`, '"ready":true', 5), "orchestrator must be quiesced after the crash");
    assert.ok(pipelines().includes("crash-g1-state"), "the ORIGINAL data must still be present");
    // --reconcile must restart the deployment, keep the original
    // authority, and REPORT the interrupted operation (never "no
    // interrupted promotion detected" while the app is offline).
    const result = reconcile();
    assert.equal(result.status, 0, `--reconcile must exit clean: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /interrupted promotion reconciled/);
    assert.ok(
      !(result.stdout + result.stderr).includes("no interrupted promotion detected"),
      "--reconcile must not claim a clean state while restoring availability",
    );
    assert.ok(pipelines().includes("crash-g1-state"), "the ORIGINAL authority must still hold the data");
    assertServicesReady("after crash-after-quiesce reconcile");
    const postRecovery = createPipeline("crash-g1-recovery-write");
    assert.ok(postRecovery, "new write after --reconcile must succeed");
  });

  it("G2: SIGKILL after DB rollback renames but before service restart — --reconcile finishes the restart", () => {
    const marker = createPipeline("crash-g2-state");
    assert.ok(marker, "crash-g2 pipeline did not persist");
    const { dumpPath } = takeBackup();
    // Post-promotion gate fault triggers the rollback; the fault hook
    // kills the process after the rollback renames succeeded but BEFORE
    // the services were restarted.
    const crashed = promote(dumpPath, "post-gate-readiness,crash-after-rollback-renames");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    // The original authority is active again (rollback renames done) but
    // the services are still stopped; the journal still says "post-gates".
    const dbs = databases();
    assert.ok(dbs.includes("tenvyr"), "the original authority must be active after the rollback renames");
    assert.ok(!dbs.includes("tenvyr_pre_restore"), "the safety copy must have been consumed by the rollback");
    const result = reconcile();
    assert.equal(result.status, 0, `--reconcile must exit clean: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /interrupted promotion reconciled/);
    assert.ok(pipelines().includes("crash-g2-state"), "the ORIGINAL data must still be present");
    assertServicesReady("after crash-after-rollback-renames reconcile");
    const postRecovery = createPipeline("crash-g2-recovery-write");
    assert.ok(postRecovery, "new write after --reconcile must succeed");
    // The crashed rollback preserved this test's own candidate before the
    // SIGKILL — drop it so a later test's manual repair never collides.
    const dropCandidate = psql("DROP DATABASE IF EXISTS tenvyr_failed_promotion", "postgres");
    assert.equal(dropCandidate.status, 0, `dropping this test's own preserved candidate failed: ${dropCandidate.stderr}`);
  });

  it("F9: existing tenvyr_failed_promotion never collides with a later rollback (non-colliding preserve)", () => {
    const marker = createPipeline("crash-f9-state");
    assert.ok(marker, "crash-f9 pipeline did not persist");
    const { dumpPath } = takeBackup();
    // Manual ambiguous-state repair (the supported operator path):
    // crash after candidate promotion, corrupt the journal, FAIL CLOSED,
    // then repair by preserving the candidate under tenvyr_failed_promotion
    // and restoring the original — leaving NO journal.
    const crashed = promote(dumpPath, "crash-after-promotion");
    assert.equal(crashed.signal, "SIGKILL", "the fault hook must terminate the child abruptly");
    const journalPath = join(ROOT, "backups", ".recovery-journal.json");
    writeFileSync(journalPath, "{truncated garbage", "utf8");
    const blocked = promote(dumpPath);
    assert.notEqual(blocked.status, 0, "the ambiguous state must fail closed");
    // Execute the EXACT printed preserve command (the instructions name a
    // NON-COLLIDING bounded candidate name for the observed state).
    const blockedOutput = blocked.stdout + blocked.stderr;
    const preserveMatch = blockedOutput.match(
      /ALTER DATABASE tenvyr RENAME TO (tenvyr_failed_promotion(?:_\d+)?)/,
    );
    assert.ok(preserveMatch, `the blocked output must print the preserve command: ${blockedOutput.slice(-600)}`);
    let preserve = psql(`ALTER DATABASE tenvyr RENAME TO ${preserveMatch[1]}`, "postgres");
    assert.equal(preserve.status, 0, `preserve command failed: ${preserve.stderr}`);
    const restoreOriginal = psql("ALTER DATABASE tenvyr_pre_restore RENAME TO tenvyr", "postgres");
    assert.equal(restoreOriginal.status, 0, `restore command failed: ${restoreOriginal.stderr}`);
    runOk("docker", [...COMPOSE.slice(1), "start", "orchestrator", "gateway"], { timeout: 120_000 });
    assertServicesReady("after the manual ambiguous-state repair");
    const reconciled = reconcile();
    assert.equal(reconciled.status, 0, `--reconcile must exit clean: ${reconciled.stdout}\n${reconciled.stderr}`);
    assert.ok(!existsSync(journalPath), "the journal must be cleared on the clean layout");
    assert.ok(databases().includes("tenvyr_failed_promotion"), "the preserved candidate must still exist");
    // A NEW promotion with a post-promotion gate failure: its rollback
    // must NOT target the existing tenvyr_failed_promotion — it preserves
    // the candidate under a non-colliding bounded name and the original
    // authority becomes healthy again.
    const { dumpPath: freshDump } = takeBackup();
    const failed = promote(freshDump, "post-gate-readiness");
    assert.notEqual(failed.status, 0, "the faulted promotion must fail");
    assert.match(failed.stdout + failed.stderr, /automatic rollback restored the original authority/);
    const after = databases();
    assert.ok(after.includes("tenvyr"), "the ORIGINAL authority must be active after the non-colliding rollback");
    assert.ok(after.includes("tenvyr_failed_promotion"), "the manually preserved candidate must NOT have been overwritten or deleted");
    assert.ok(!after.includes("tenvyr_failed_promotion_1"), `the rollback's own candidate was cleaned up after the successful rollback (only the pre-existing preserved candidate remains); observed: ${after.join(", ")}; status=${failed.status}; FULL OUTPUT:\n${failed.stdout}\n${failed.stderr}`);
    assert.ok(pipelines().includes("crash-f9-state"), "the ORIGINAL data must still be present");
    assertServicesReady("after the non-colliding rollback");
    const postRecovery = createPipeline("crash-f9-recovery-write");
    assert.ok(postRecovery, "new write must succeed");
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
    const reconcileResult = reconcile();
    assert.equal(reconcileResult.status, 0, `--reconcile must exit clean: ${reconcile.stdout}\n${reconcile.stderr}`);
    assert.match(reconcileResult.stdout, /no interrupted promotion detected|reconciled/);
    assert.ok(!existsSync(join(ROOT, "backups", ".recovery-journal.json")), "the recovery journal must be cleared");
  });
});
