#!/usr/bin/env node
/**
 * M11-S3: verified single-owner upgrade.
 *
 * `pnpm self-hosted:upgrade <target-version>`:
 *   1. validates the target version (supported vMAJOR.MINOR.PATCH shape,
 *      numeric comparison, no downgrade from the deployed TENVYR_VERSION,
 *      no no-op),
 *   2. PROVES the source identity (target is a real git tag, HEAD == tag
 *      commit, clean tree — see proveSourceIdentity),
 *   3. takes a VERIFIED backup FIRST (backup.mjs reports PASS only for a
 *      dump whose manifest was proven against an isolated restore of that
 *      exact dump) — any backup failure aborts BEFORE compose build/up or
 *      any other deployment mutation,
 *   4. resolves the Compose stack WITH the target version and FAILS CLOSED
 *      if the resolved Tenvyr services do not point at the requested
 *      target — the stack is never mutated on a mismatch,
 *   5. builds/pulls the pinned target image and recreates the stack with
 *      TENVYR_VERSION=<target> (an environment override, never a silent
 *      deploy.env edit),
 *   6. waits for orchestrator + gateway readiness,
 *   7. verifies the RUNNING containers' image tags AND baked
 *      TENVYR_SOURCE_REVISION actually target the requested version — no
 *      stale-version false success,
 *   8. runs the executable invariants; a failed migration stops unhealthy
 *      (non-zero exit) and preserves the backup + diagnostics,
 *   9. ONLY then persists the deployed version + source revision into
 *      deploy.env (metadata stays truthful on any failure path).
 *
 * No exactly-once runtime execution or zero-downtime upgrade is claimed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { acquireMaintenanceLock, releaseMaintenanceLock } from "./maintenance.mjs";

/** The verified-backup operation is invoked IN THIS PROCESS while the
 *  maintenance lock is held (there is no upgrade->backup child and
 *  therefore nothing that could survive the owner's death and overlap a
 *  new owner). `TENVYR_UPGRADE_BACKUP_MODULE` is a bounded test seam
 *  (never set in production) pointing at a module exporting
 *  runVerifiedBackup. */
const backupModuleUrl = pathToFileURL(
  join(import.meta.dirname, process.env.TENVYR_UPGRADE_BACKUP_MODULE ?? "backup.mjs"),
).href;
const { runVerifiedBackup } = await import(backupModuleUrl);

const ROOT = join(import.meta.dirname, "..", "..");

/** Supported version shape: vMAJOR.MINOR.PATCH (semver-ish, no suffixes). */
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

/** Immutable source revision: the full 40-hex git commit SHA. */
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Deployment identity model (M11 closure) — ONE documented meaning per key:
 *
 *   TENVYR_VERSION          releaseVersion — vMAJOR.MINOR.PATCH, the image
 *                           tag, and MUST name an existing git tag in this
 *                           repository (the exact approved release).
 *   TENVYR_SOURCE_REVISION  sourceRevision — the immutable full git commit
 *                           SHA the images were actually built from.
 *
 * An image tag alone is never proof of an upgrade: arbitrary old source
 * could be rebuilt under a newer tag. A source-build upgrade therefore
 * PROVES the checkout is the exact clean release commit before anything is
 * built, bakes the proven SHA into the images, verifies it on the RUNNING
 * containers after recreate, and records both values in deploy.env only
 * after the whole upgrade is proven.
 */

/**
 * Numeric semantic version comparison: major, then minor, then patch.
 * Never relies on JS array/string relational behavior.
 * Returns -1 | 0 | 1 for (left vs right).
 */
export const compareVersions = (left, right) => {
  const [lmajor, lminor, lpatch] = left.slice(1).split(".").map(Number);
  const [rmajor, rminor, rpatch] = right.slice(1).split(".").map(Number);
  if (lmajor !== rmajor) return lmajor < rmajor ? -1 : 1;
  if (lminor !== rminor) return lminor < rminor ? -1 : 1;
  if (lpatch !== rpatch) return lpatch < rpatch ? -1 : 1;
  return 0;
};

export const validateTargetVersion = (target, current) => {
  if (!VERSION_PATTERN.test(target)) {
    return { ok: false, reason: `unsupported target version "${target}": expected vMAJOR.MINOR.PATCH` };
  }
  if (current && !VERSION_PATTERN.test(current)) {
    return { ok: false, reason: `deployed TENVYR_VERSION "${current}" is not a supported version shape` };
  }
  if (current && target === current) {
    return { ok: false, reason: `target "${target}" equals the deployed version; nothing to upgrade` };
  }
  if (current && compareVersions(target, current) < 0) {
    return { ok: false, reason: `target "${target}" is older than deployed "${current}"; downgrades are not supported (restore is the documented recovery)` };
  }
  return { ok: true };
};

/** The image tags the requested target MUST resolve to in the compose file. */
export const expectedImageTags = (target) => ({
  orchestrator: `tenvyr-orchestrator:${target}`,
  gateway: `tenvyr-gateway:${target}`,
});

/** Runs a git command against the repository root. Injectable for tests
 *  via TENVYR_GIT_CMD (a bounded test seam — never set in production). */
export const runGit = (args) =>
  spawnSync(process.env.TENVYR_GIT_CMD ?? "git", args, { cwd: ROOT, encoding: "utf8" });

/**
 * M11 closure: proves the current checkout IS the exact approved release.
 * A source-build upgrade must never rebuild arbitrary old source under a
 * newer target tag — the checkout HEAD must equal the target's tag commit
 * AND the working tree must be clean. Returns the immutable source
 * revision (full commit SHA) on success.
 */
export const proveSourceIdentity = (target, git = runGit) => {
  const tag = git(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
  if (tag.status !== 0 || !tag.stdout.trim()) {
    return {
      ok: false,
      reason: `no release tag "${target}" exists in this repository — a source-build upgrade requires the target to be a real git tag naming the exact approved release (prerequisite: tag the release commit vMAJOR.MINOR.PATCH)`,
    };
  }
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) {
    return { ok: false, reason: "could not read the current checkout HEAD" };
  }
  const tagCommit = tag.stdout.trim();
  const headCommit = head.stdout.trim();
  if (headCommit !== tagCommit) {
    return {
      ok: false,
      reason: `checkout HEAD ${headCommit.slice(0, 12)} is not the approved release commit ${tagCommit.slice(0, 12)} of "${target}" — refusing to build old source under a newer target tag`,
    };
  }
  const dirty = git(["status", "--porcelain"]);
  if (dirty.status !== 0 || dirty.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: `working tree is not clean for "${target}" (${dirty.stdout.trim().split("\n").length} changed/untracked paths) — a source-build upgrade requires an exact clean checkout of the release commit`,
    };
  }
  if (!SOURCE_REVISION_PATTERN.test(tagCommit)) {
    return {
      ok: false,
      reason: `release tag "${target}" does not resolve to a full commit SHA`,
    };
  }
  return { ok: true, sourceRevision: tagCommit };
};

/**
 * M11 closure: the RUNNING container's baked source identity must equal the
 * proven source revision — the image tag alone is never sufficient proof.
 * Accepts `docker inspect --format '{{.Config.Env}}'` output.
 */
export const runningSourceMatches = (envText, sourceRevision) =>
  envText.includes(`TENVYR_SOURCE_REVISION=${sourceRevision}`);

/**
 * Verifies a resolved `docker compose config` output: every versioned
 * Tenvyr service image must point at the requested target. Returns the
 * list of mismatches (empty = the deployment would target the request).
 */
export const resolvedTagsMatch = (resolvedConfig, target) => {
  const expected = expectedImageTags(target);
  const mismatches = [];
  for (const image of Object.values(expected)) {
    if (!resolvedConfig.includes(image)) {
      mismatches.push(`resolved compose does not contain image "${image}"`);
    }
  }
  // Floating or unversioned Tenvyr images are never acceptable.
  for (const line of resolvedConfig.split("\n")) {
    const match = line.match(/^\s*image:\s*(tenvyr-orchestrator|tenvyr-gateway):(\S+)/);
    if (match && match[2] !== target) {
      mismatches.push(`resolved image "${match[1]}:${match[2]}" does not target "${target}"`);
    }
  }
  return mismatches;
};

/**
 * Returns the deploy.env text with TENVYR_VERSION set to `target` and
 * TENVYR_SOURCE_REVISION set to the proven `sourceRevision`, preserving
 * comments and all other lines. Pure (no I/O) so the contract test can
 * prove that upgrade success is what persists the metadata.
 */
export const applyDeployedMetadata = (deployEnvText, target, sourceRevision) => {
  const updated = [];
  let versionReplaced = false;
  let sourceReplaced = false;
  for (const line of deployEnvText.split("\n")) {
    if (/^TENVYR_VERSION=/.test(line)) {
      updated.push(`TENVYR_VERSION=${target}`);
      versionReplaced = true;
    } else if (/^TENVYR_SOURCE_REVISION=/.test(line)) {
      updated.push(`TENVYR_SOURCE_REVISION=${sourceRevision}`);
      sourceReplaced = true;
    } else {
      updated.push(line);
    }
  }
  if (!versionReplaced) updated.push(`TENVYR_VERSION=${target}`);
  if (!sourceReplaced) updated.push(`TENVYR_SOURCE_REVISION=${sourceRevision}`);
  return `${updated.join("\n").replace(/\n+$/, "")}\n`;
};

/** Deploy env file: overridable so disposable-infrastructure tests never
 *  touch an operator's real deploy.env. */
const deployEnvPath = () =>
  process.env.TENVYR_DEPLOY_ENV ?? join(ROOT, "deploy.env");

const env = () => {
  const path = deployEnvPath();
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    values[key.trim()] = rest.join("=").trim();
  }
  return values;
};

const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  return result.status ?? 1;
};

export const main = () => {
  // Maintenance serialization: the upgrade owns the exclusive maintenance
  // lock for its whole run, and the verified backup runs IN THIS PROCESS
  // while the lock is held (no child, no inheritance — nothing can
  // survive the owner's death and overlap a new owner). A crashed
  // upgrade releases the lock automatically: the next acquisition
  // Stale/uncertain maintenance state FAILS CLOSED (a dead owner does not
  // prove its docker/DB descendants are dead) — the lock is never
  // auto-reclaimed; the operator clears it explicitly.
  const lock = acquireMaintenanceLock();
  if (!lock.owned) {
    console.error(`[upgrade] FAIL: ${lock.denied ?? "maintenance operation already active"} — refusing to bypass serialization`);
    if (lock.instructions) {
      console.error("[upgrade] stale/uncertain maintenance state — bounded operator recovery:");
      for (const step of lock.instructions) {
        console.error(`  ${step}`);
      }
    } else if (lock.owner) {
      console.error(
        `[upgrade] (owner pid ${lock.owner.pid} since ${lock.owner.startedAt})`,
      );
    }
    // No lock is held here (acquisition failed) — plain exit is correct.
    process.exit(1);
  }
  const exit = (code) => {
    releaseMaintenanceLock(lock);
    process.exit(code);
  };
  const target = process.argv[2];
  if (!target) {
    console.error("[upgrade] usage: upgrade.mjs <target-version>");
    exit(1);
  }
  const deployed = env().TENVYR_VERSION;
  const check = validateTargetVersion(target, deployed);
  if (!check.ok) {
    console.error(`[upgrade] FAIL: ${check.reason}`);
    exit(1);
  }
  // 1. PROVE the source identity BEFORE anything is built or mutated: the
  // checkout must be the exact clean commit of the release tag, otherwise
  // arbitrary old source would be rebuilt under the newer target tag.
  const provenance = proveSourceIdentity(target);
  if (!provenance.ok) {
    console.error(`[upgrade] FAIL: ${provenance.reason}`);
    console.error("[upgrade] the stack was NOT touched; deploy.env is unchanged");
    exit(1);
  }
  const sourceRevision = provenance.sourceRevision;
  console.log(
    `[upgrade] ok: checkout is the exact clean release commit ${sourceRevision.slice(0, 12)} of ${target}`,
  );
  // Compose env override: the shell environment takes precedence over
  // --env-file, so the requested target propagates into the resolved
  // config WITHOUT touching deploy.env (which stays truthful until the
  // upgrade actually succeeds).
  const composeEnv = { ...process.env, TENVYR_VERSION: target };
  const compose = [
    "docker",
    "compose",
    ...(process.env.TENVYR_SELF_HOSTED_PROJECT ? ["-p", process.env.TENVYR_SELF_HOSTED_PROJECT] : []),
    "-f",
    "docker-compose.self-hosted.yml",
    ...(process.env.TENVYR_SELF_HOSTED_COMPOSE_OVERRIDE ? ["-f", process.env.TENVYR_SELF_HOSTED_COMPOSE_OVERRIDE] : []),
    "--env-file",
    deployEnvPath(),
  ];

  // 1. Verified backup first (the documented recovery path). The
  //    verified-backup operation runs IN THIS PROCESS while the
  //    maintenance lock is held: backup.mjs reports PASS only for a dump
  //    whose manifest was proven against an isolated restore of that
  //    exact dump — so a success here is a VERIFIED recovery artifact.
  //    Any backup failure aborts the upgrade BEFORE compose build/up or
  //    any other deployment mutation.
  console.log("[upgrade] taking VERIFIED backup before touching the stack...");
  try {
    const backup = runVerifiedBackup({ deployEnvPath: deployEnvPath() });
    if (!backup?.ok) {
      throw new Error("verified backup did not complete");
    }
    console.log(`[upgrade] ok: verified backup ${backup.dumpPath}`);
  } catch (error) {
    console.error(
      `[upgrade] FAIL: verified backup did not complete (${error instanceof Error ? error.message : String(error)}); refusing to build or mutate the deployment`,
    );
    exit(1);
  }

  // 2. FAIL-CLOSED resolution check: the compose config with the requested
  //    target must resolve every versioned Tenvyr service to that target.
  console.log(`[upgrade] resolving compose config at ${target}...`);
  const resolved = spawnSync(compose[0], [...compose.slice(1), "config"], {
    cwd: ROOT,
    encoding: "utf8",
    env: composeEnv,
    timeout: 30_000,
  });
  if (resolved.status !== 0) {
    console.error(`[upgrade] FAIL: compose config did not resolve: ${resolved.stderr?.slice(0, 500)}`);
    exit(1);
  }
  const mismatches = resolvedTagsMatch(resolved.stdout, target);
  if (mismatches.length > 0) {
    console.error("[upgrade] FAIL: resolved deployment does not target the requested version:");
    for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
    console.error("[upgrade] the stack was NOT touched; deploy.env is unchanged");
    exit(1);
  }
  console.log(`[upgrade] ok: resolved Tenvyr images target ${target}`);

  // 3. Build/pull the pinned target image and recreate WITH the target.
  //    The proven source revision is baked into the images as
  //    TENVYR_SOURCE_REVISION so the RUNNING containers can prove the
  //    exact source they were built from — an image tag alone is never
  //    sufficient proof.
  console.log(`[upgrade] building/pulling tenvyr images at ${target}...`);
  const buildArgs = ["--build-arg", `TENVYR_SOURCE_REVISION=${sourceRevision}`];
  if (run(compose[0], [...compose.slice(1), "build", ...buildArgs], { env: composeEnv }) !== 0) {
    console.error("[upgrade] FAIL: image build failed; the stack was NOT touched and the backup is preserved");
    exit(1);
  }
  if (run(compose[0], [...compose.slice(1), "up", "-d"], { env: composeEnv }) !== 0) {
    console.error("[upgrade] FAIL: stack recreate failed; the backup is preserved");
    exit(1);
  }

  // 4. Readiness wait (orchestrator + gateway).
  const waitForHealth = (url, expected, attempts = 20) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const probe = spawnSync("curl", ["-s", url], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 5_000,
      });
      if (probe.status === 0 && probe.stdout.includes(expected)) return true;
      // Bounded backoff: the compose healthchecks race the probe.
      const sleepUntil = Date.now() + 500;
      while (Date.now() < sleepUntil) {
        // synchronous CLI sleep
      }
    }
    return false;
  };
  const orchestratorReady = waitForHealth(
    `http://127.0.0.1:${process.env.TENVYR_ORCHESTRATOR_PORT ?? 3001}/health`,
    '"ready":true',
  );
  if (!orchestratorReady) {
    console.error("[upgrade] FAIL: orchestrator not ready after upgrade; run `pnpm self-hosted:invariants` and restore from the preserved backup");
    exit(1);
  }
  const gatewayReady = waitForHealth(`http://127.0.0.1:${process.env.TENVYR_GATEWAY_PORT ?? 3000}/health`, "UP");
  if (!gatewayReady) {
    console.error("[upgrade] FAIL: gateway not ready after upgrade; run `pnpm self-hosted:invariants` and restore from the preserved backup");
    exit(1);
  }

  // 5. PROVE the RUNNING deployment targets the requested version — never
  //    print target-version success from a stale stack.
  const ps = spawnSync(compose[0], [...compose.slice(1), "ps", "--format", "{{.Service}} {{.Image}}"], {
    cwd: ROOT,
    encoding: "utf8",
    env: composeEnv,
    timeout: 30_000,
  });
  const expected = expectedImageTags(target);
  let runningMismatch = null;
  if (ps.status !== 0 || !ps.stdout) {
    runningMismatch = "could not read running container images";
  } else {
    const runningImages = ps.stdout.split("\n").filter(Boolean);
    for (const line of runningImages) {
      const [service, image] = line.split(/\s+/);
      if (service === "orchestrator" && image !== expected.orchestrator) {
        runningMismatch = `orchestrator runs "${image}", expected "${expected.orchestrator}"`;
      }
      if (service === "gateway" && image !== expected.gateway) {
        runningMismatch = `gateway runs "${image}", expected "${expected.gateway}"`;
      }
    }
  }
  if (runningMismatch) {
    console.error(`[upgrade] FAIL: ${runningMismatch}`);
    console.error("[upgrade] the stack was recreated but does not run the requested target; deploy.env is unchanged; restore from the preserved backup");
    exit(1);
  }
  console.log(`[upgrade] ok: running orchestrator/gateway images target ${target}`);

  // 5b. PROVE the RUNNING containers' SOURCE identity: the baked
  //     TENVYR_SOURCE_REVISION must equal the proven release commit. The
  //     image tag alone is never sufficient proof — arbitrary old source
  //     could wear a newer tag.
  for (const container of ["tenvyr-self-hosted-orchestrator", "tenvyr-self-hosted-gateway"]) {
    const inspect = spawnSync(
      "docker",
      ["inspect", "--format", "{{.Config.Env}}", container],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    if (inspect.status !== 0 || !runningSourceMatches(inspect.stdout, sourceRevision)) {
      console.error(
        `[upgrade] FAIL: running container "${container}" does not carry the proven source revision ${sourceRevision} (baked TENVYR_SOURCE_REVISION missing or mismatched)`,
      );
      console.error("[upgrade] prebuilt images must be verified by digest against the target release; the stack was recreated but deploy.env is unchanged; restore from the preserved backup");
      exit(1);
    }
  }
  console.log(`[upgrade] ok: running containers carry the proven source revision ${sourceRevision.slice(0, 12)}`);

  // 6. Executable invariants.
  console.log("[upgrade] running post-upgrade invariants...");
  const invariants = run(process.execPath, ["scripts/self-hosted/invariants.mjs"]);
  if (invariants !== 0) {
    console.error("[upgrade] FAIL: post-upgrade invariants failed; the backup is preserved and deploy.env is unchanged");
    exit(1);
  }

  // 7. Persist deployed metadata ONLY after the upgrade is proven:
  //    TENVYR_VERSION (release version) AND TENVYR_SOURCE_REVISION (the
  //    immutable commit the running images were proven built from).
  const currentText = readFileSync(deployEnvPath(), "utf8");
  writeFileSync(
    deployEnvPath(),
    applyDeployedMetadata(currentText, target, sourceRevision),
  );
  console.log(`[upgrade] OK: upgraded to ${target} with verified backup, proven running target, proven source revision, and green invariants`);
  console.log(`[upgrade] deploy.env TENVYR_VERSION=${target} TENVYR_SOURCE_REVISION=${sourceRevision} (persisted after success)`);
  releaseMaintenanceLock(lock);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
