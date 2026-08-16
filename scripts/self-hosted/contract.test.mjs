/**
 * M11-S1: the supported self-hosted deployment contract, as code.
 * Every assertion here pins the topology/version/trust/data contract
 * documented in docs/operations/self-hosted.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = readFileSync(
  join(ROOT, "docker-compose.self-hosted.yml"),
  "utf8",
);
const ENV_EXAMPLE = readFileSync(
  join(ROOT, ".env.self-hosted.example"),
  "utf8",
);

/** Dynamic import of a self-hosted module (lazy — the modules carry
 *  entry guards and must not execute at contract-suite load time). A
 *  hoisted function declaration: never a TDZ under test-name filters. */
function awaitImport(relative) {
  return import(join(dirname(fileURLToPath(import.meta.url)), relative));
}

test("self-hosted profile binds loopback only (no public ports by default)", () => {
  const portLines = COMPOSE.split("\n").filter((line) =>
    line.includes('"127.0.0.1:'),
  );
  assert.ok(
    portLines.length >= 3,
    "expected postgres/orchestrator/gateway loopback bindings",
  );
  const publicLines = COMPOSE.split("\n").filter((line) =>
    /^\s+- "\d+:\d+"\s*$/.test(line),
  );
  assert.equal(
    publicLines.length,
    0,
    `public bindings present: ${publicLines.join(", ")}`,
  );
});

test("self-hosted profile pins versions (no :latest floats)", () => {
  assert.ok(
    !COMPOSE.includes(":latest"),
    "floating :latest tag in the profile",
  );
  assert.match(COMPOSE, /postgres:15-alpine/);
});

test("named volumes exist and hold the authority", () => {
  assert.match(COMPOSE, /tenvyr_postgres_data:/);
  assert.match(
    COMPOSE,
    /- "\$\{TENVYR_POSTGRES_VOLUME:-tenvyr_postgres_data\}:\/var\/lib\/postgresql\/data"/,
  );
  // The disposable recovery-E2E volume is DECLARED but never created by
  // the production profile (the E2E mounts it under its own project).
  assert.match(COMPOSE, /recovery_e2e_postgres_data:/);
});

test("orchestrator/gateway consume ORCHESTRATOR_PORT/GATEWAY_PORT (never PORT)", () => {
  const orchestratorBlock = COMPOSE.split("\n").find((line) =>
    line.includes("ORCHESTRATOR_PORT"),
  );
  assert.ok(orchestratorBlock, "ORCHESTRATOR_PORT missing from the profile");
  assert.match(COMPOSE, /GATEWAY_PORT: "3000"/);
  for (const line of COMPOSE.split("\n")) {
    if (/^\s+PORT: /.test(line)) {
      assert.fail(`legacy PORT: assignment in the profile: ${line.trim()}`);
    }
  }
});

test("orchestrator consumes the POSTGRES_* contract with interpolated password", () => {
  // The container names are parameterized so the disposable recovery-E2E
  // stack is physically separate (unique project/containers/volume/ports).
  const containerDelimiter = (service) =>
    COMPOSE.indexOf(
      `container_name: ${"${TENVYR_SELF_HOSTED_PREFIX:-tenvyr-self-hosted}"}-${service}`,
    );
  const orchestratorIndex = containerDelimiter("orchestrator");
  const gatewayIndex = containerDelimiter("gateway");
  const orchestratorBlock = COMPOSE.slice(orchestratorIndex, gatewayIndex);
  assert.ok(
    orchestratorBlock.includes("POSTGRES_HOST: postgres"),
    "POSTGRES_HOST missing",
  );
  assert.ok(
    orchestratorBlock.includes("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD"),
    "password not interpolated",
  );
  assert.ok(
    !orchestratorBlock.includes("DATABASE_URL"),
    "dead DATABASE_URL in the profile",
  );
  assert.ok(
    !orchestratorBlock.includes("REDIS_URL"),
    "unused REDIS_URL in the profile",
  );
  assert.ok(
    !/^\s+PORT: /m.test(orchestratorBlock),
    "legacy PORT assignment in orchestrator env",
  );
});

test("no unused redis service in the self-hosted profile", () => {
  assert.ok(
    !COMPOSE.includes("container_name: tenvyr-self-hosted-redis"),
    "unused redis still shipped",
  );
  assert.ok(
    !COMPOSE.includes("tenvyr_redis_data"),
    "unused redis volume still shipped",
  );
});

test("compose consumes secret REFERENCES only — no live values", () => {
  const suspicious = COMPOSE.split("\n").filter(
    (line) =>
      line.includes("PASSWORD") &&
      !line.includes("${") &&
      !line.includes("#") &&
      line.includes(":"),
  );
  assert.equal(
    suspicious.length,
    0,
    `inline secrets in the profile: ${suspicious.join(", ")}`,
  );
  assert.match(COMPOSE, /\$\{POSTGRES_PASSWORD:?/);
  assert.match(COMPOSE, /\$\{HTTP_AGENT_CALLBACK_KEYS:?/);
});

test(".env.self-hosted.example is references-only with no values", () => {
  for (const line of ENV_EXAMPLE.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const value = line.split("=").slice(1).join("=").trim();
    assert.ok(
      value === "" ||
        value.startsWith("{") ||
        value.startsWith("http") ||
        value.startsWith("#"),
      `placeholder value leaked into example line: ${line}`,
    );
  }
  assert.match(ENV_EXAMPLE, /openssl rand -hex 32/);
});

test("data inventory matches the backup script's table list", () => {
  const anchors = readFileSync(
    join(ROOT, "scripts", "self-hosted", "anchors.mjs"),
    "utf8",
  );
  const backup = readFileSync(
    join(ROOT, "scripts", "self-hosted", "backup.mjs"),
    "utf8",
  );
  for (const table of [
    "executions",
    "execution_plan_revisions",
    "step_attempts",
    "dispatch_outbox",
    "result_inbox",
    "policy_decisions",
    "budget_accounts",
    "approval_requests",
    "artifacts",
    "runtime_connections",
    "connection_revisions",
    "coordination_runs",
    "coordination_iterations",
    "operator_actions",
  ]) {
    assert.ok(anchors.includes(table), `anchor inventory missing ${table}`);
  }
  // The backup script must consume the SHARED inventory, never a private copy.
  assert.match(backup, /from "\.\/anchors\.mjs"/);
  assert.match(backup, /inventoryFingerprintValue\(\)/);
});

test("restore verifies checksum and version before touching the target", () => {
  const restore = readFileSync(
    join(ROOT, "scripts", "self-hosted", "restore.mjs"),
    "utf8",
  );
  const anchors = readFileSync(
    join(ROOT, "scripts", "self-hosted", "anchors.mjs"),
    "utf8",
  );
  // The fail-closed manifest contract lives in anchors.mjs and is invoked
  // by restore's pre-quiesce verifyBackup.
  assert.match(anchors, /checksum mismatch — refusing to restore/);
  assert.match(anchors, /backup version .* does not match deployment/);
  assert.match(restore, /validateManifestContract\(/);
  assert.match(restore, /DROP DATABASE IF EXISTS/);
  assert.match(restore, /tenvyr_restore/);
});

test("clean checkout is bootable: orchestrator and gateway declare build contexts", () => {
  const containerDelimiter = (service) =>
    COMPOSE.indexOf(
      `container_name: ${"${TENVYR_SELF_HOSTED_PREFIX:-tenvyr-self-hosted}"}-${service}`,
    );
  const orchestratorIndex = containerDelimiter("orchestrator");
  const gatewayIndex = containerDelimiter("gateway");
  const orchestratorBlock = COMPOSE.slice(0, orchestratorIndex);
  assert.match(
    orchestratorBlock,
    /build:\n\s+context: \.\n\s+dockerfile: services\/orchestrator\/Dockerfile\n\s+target: production/,
  );
  const gatewayBlock = COMPOSE.slice(orchestratorIndex, gatewayIndex);
  assert.match(
    gatewayBlock,
    /build:\n\s+context: \.\n\s+dockerfile: services\/gateway\/Dockerfile\n\s+target: production/,
  );
  // The Dockerfiles the build contract points at exist.
  assert.ok(existsSync(join(ROOT, "services", "orchestrator", "Dockerfile")));
  assert.ok(existsSync(join(ROOT, "services", "gateway", "Dockerfile")));
});

test("upgrade validates target versions executably (supported shape, no downgrade, no no-op)", async () => {
  const { validateTargetVersion } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  assert.equal(validateTargetVersion("v0.4.2", "v0.3.1").ok, true);
  assert.equal(validateTargetVersion("v0.4.2", undefined).ok, true);
  assert.equal(validateTargetVersion("0.4.2", "v0.3.1").ok, false);
  assert.equal(validateTargetVersion("v0.4.2-beta.1", "v0.3.1").ok, false);
  assert.equal(validateTargetVersion("v0.2.0", "v0.3.1").ok, false);
  assert.equal(validateTargetVersion("v0.3.1", "v0.3.1").ok, false);
});

test("upgrade compares versions NUMERICALLY (major, then minor, then patch)", async () => {
  const { compareVersions, validateTargetVersion } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  assert.equal(compareVersions("v1.10.0", "v1.2.0"), 1);
  assert.equal(compareVersions("v10.0.0", "v2.0.0"), 1);
  assert.equal(compareVersions("v1.2.0", "v1.10.0"), -1);
  assert.equal(compareVersions("v2.0.0", "v1.99.99"), 1);
  assert.equal(compareVersions("v1.2.10", "v1.2.9"), 1);
  assert.equal(compareVersions("v1.2.0", "v1.2.0"), 0);
  // Downgrade rejection must hold for MINOR and PATCH differences — the
  // JS array-comparison trap (v1.2.0 vs v1.10.0 both directions false).
  assert.equal(validateTargetVersion("v1.2.0", "v1.10.0").ok, false);
  assert.equal(validateTargetVersion("v1.2.9", "v1.2.10").ok, false);
  assert.equal(validateTargetVersion("v1.10.0", "v1.2.0").ok, true);
});

test("upgrade propagates the target into the resolved deployment and fails closed on mismatch", async () => {
  const { expectedImageTags, resolvedTagsMatch, applyDeployedMetadata } =
    await awaitImport("../self-hosted/upgrade.mjs");
  const expected = expectedImageTags("v1.10.0");
  assert.equal(expected.orchestrator, "tenvyr-orchestrator:v1.10.0");
  assert.equal(expected.gateway, "tenvyr-gateway:v1.10.0");
  // Resolved config pointing at the target passes.
  const matching = `
services:
  orchestrator:
    image: tenvyr-orchestrator:v1.10.0
  gateway:
    image: tenvyr-gateway:v1.10.0
`;
  assert.deepEqual(resolvedTagsMatch(matching, "v1.10.0"), []);
  // Any Tenvyr service resolving to a different version aborts.
  const stale = `
services:
  orchestrator:
    image: tenvyr-orchestrator:v1.2.0
  gateway:
    image: tenvyr-gateway:v1.10.0
`;
  assert.ok(
    resolvedTagsMatch(stale, "v1.10.0").length > 0,
    "stale orchestrator image must fail closed",
  );
  assert.ok(
    resolvedTagsMatch("", "v1.10.0").length > 0,
    "missing images must fail closed",
  );
  // Deployed-version metadata is written ONLY by the success path helper,
  // and it records BOTH the release version and the immutable source
  // revision — an image tag alone is never the deployed identity.
  const before =
    "# deploy comment\nTENVYR_VERSION=v1.2.0\nPOSTGRES_PASSWORD=ref\n";
  const after = applyDeployedMetadata(before, "v1.10.0", "a".repeat(40));
  assert.match(after, /TENVYR_VERSION=v1\.10\.0/);
  assert.ok(
    !after.includes("TENVYR_VERSION=v1.2.0"),
    "old deployed version must be replaced",
  );
  assert.match(after, /TENVYR_SOURCE_REVISION=a{40}/);
  assert.match(after, /POSTGRES_PASSWORD=ref/);
  assert.match(after, /# deploy comment/);
  const added = applyDeployedMetadata(
    "# no version yet\n",
    "v0.4.0",
    "b".repeat(40),
  );
  assert.ok(added.includes("TENVYR_VERSION=v0.4.0"));
  assert.ok(added.includes(`TENVYR_SOURCE_REVISION=${"b".repeat(40)}`));
});

test("upgrade PROVES the checkout is the exact clean release commit before anything is built", async () => {
  const { proveSourceIdentity } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  const tagCommit = "c".repeat(40);
  // A fake git runner: record the calls, answer per argument vector.
  const fakeGit = (calls) => (args) => {
    calls.push(args);
    const [cmd, ...rest] = args;
    if (cmd === "rev-parse" && rest[0] === "--verify") {
      return { status: 0, stdout: `${tagCommit}\n` };
    }
    if (cmd === "rev-parse" && rest[0] === "HEAD") {
      return { status: 0, stdout: `${tagCommit}\n` };
    }
    if (cmd === "status") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  const calls = [];
  const ok = proveSourceIdentity("v1.10.0", fakeGit(calls));
  assert.equal(ok.ok, true);
  assert.equal(ok.sourceRevision, tagCommit);
  // The tag is resolved BEFORE the checkout is trusted: HEAD and dirtiness
  // are only meaningful against the tag's commit.
  assert.deepEqual(calls[0], [
    "rev-parse",
    "--verify",
    "--quiet",
    "v1.10.0^{commit}",
  ]);
});

test("upgrade refuses a target with NO release tag (fails closed; tag is the prerequisite)", async () => {
  const { proveSourceIdentity } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  const noTag = proveSourceIdentity("v9.9.9", () => ({
    status: 1,
    stdout: "",
  }));
  assert.equal(noTag.ok, false);
  assert.match(noTag.reason, /no release tag "v9\.9\.9" exists/);
});

test("upgrade refuses a checkout that is not the approved release commit (old source under a newer tag)", async () => {
  const { proveSourceIdentity } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  const tagCommit = "c".repeat(40);
  const fakeGit = (args) => {
    const [cmd, ...rest] = args;
    if (cmd === "rev-parse" && rest[0] === "--verify") {
      return { status: 0, stdout: `${tagCommit}\n` };
    }
    if (cmd === "rev-parse" && rest[0] === "HEAD") {
      return { status: 0, stdout: `${"d".repeat(40)}\n` };
    }
    return { status: 0, stdout: "" };
  };
  const mismatch = proveSourceIdentity("v1.10.0", fakeGit);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /not the approved release commit/);
  assert.match(
    mismatch.reason,
    /refusing to build old source under a newer target tag/,
  );
});

test("upgrade refuses a dirty working tree", async () => {
  const { proveSourceIdentity } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  const tagCommit = "c".repeat(40);
  const fakeGit = (args) => {
    const [cmd, ...rest] = args;
    if (cmd === "rev-parse" && rest[0] === "--verify") {
      return { status: 0, stdout: `${tagCommit}\n` };
    }
    if (cmd === "rev-parse" && rest[0] === "HEAD") {
      return { status: 0, stdout: `${tagCommit}\n` };
    }
    if (cmd === "status") {
      return {
        status: 0,
        stdout: " M services/orchestrator/src/app.controller.ts\n",
      };
    }
    return { status: 0, stdout: "" };
  };
  const dirty = proveSourceIdentity("v1.10.0", fakeGit);
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /working tree is not clean/);
});

test("upgrade verifies the RUNNING containers' baked source revision — image tag alone is insufficient proof", async () => {
  const { runningSourceMatches, expectedImageTags } = await awaitImport(
    "../self-hosted/upgrade.mjs",
  );
  const revision = "c".repeat(40);
  assert.equal(
    runningSourceMatches(
      `[NODE_ENV=production TENVYR_SOURCE_REVISION=${revision}]`,
      revision,
    ),
    true,
  );
  assert.equal(runningSourceMatches(`[NODE_ENV=production]`, revision), false);
  assert.equal(
    runningSourceMatches(
      `[TENVYR_SOURCE_REVISION=${"d".repeat(40)}]`,
      revision,
    ),
    false,
  );
  // The Dockerfiles bake the build arg into the production image.
  const orchestratorDockerfile = readFileSync(
    join(ROOT, "services", "orchestrator", "Dockerfile"),
    "utf8",
  );
  const gatewayDockerfile = readFileSync(
    join(ROOT, "services", "gateway", "Dockerfile"),
    "utf8",
  );
  for (const dockerfile of [orchestratorDockerfile, gatewayDockerfile]) {
    assert.match(dockerfile, /ARG TENVYR_SOURCE_REVISION/);
    assert.match(
      dockerfile,
      /ENV TENVYR_SOURCE_REVISION=\$\{TENVYR_SOURCE_REVISION\}/,
    );
  }
  // The upgrade flow: tag identity is checked in the compose resolution
  // AND the baked source revision is verified on the running containers;
  // the persisted metadata records the immutable source revision too.
  const upgrade = readFileSync(
    join(ROOT, "scripts", "self-hosted", "upgrade.mjs"),
    "utf8",
  );
  assert.match(upgrade, /image tag alone is never/);
  assert.match(upgrade, /expectedImageTags\(target\)/);
  assert.match(upgrade, /runningSourceMatches/);
  assert.match(upgrade, /TENVYR_SOURCE_REVISION=\$\{sourceRevision\}/);
});

test("upgrade proves source identity BEFORE any stack mutation (source check precedes build/up)", async () => {
  const upgrade = readFileSync(
    join(ROOT, "scripts", "self-hosted", "upgrade.mjs"),
    "utf8",
  );
  const proveIndex = upgrade.indexOf("proveSourceIdentity(target)");
  const buildIndex = upgrade.indexOf('"build"');
  const upIndex = upgrade.indexOf('"up", "-d"');
  assert.ok(proveIndex >= 0, "proveSourceIdentity call missing");
  assert.ok(buildIndex >= 0 && upIndex >= 0, "build/up commands missing");
  assert.ok(
    proveIndex < buildIndex,
    "source identity must be proven before build",
  );
  assert.ok(proveIndex < upIndex, "source identity must be proven before up");
});

test("restore explicitly separates drill from recovery/promotion", async () => {
  const restore = readFileSync(
    join(ROOT, "scripts", "self-hosted", "restore.mjs"),
    "utf8",
  );
  assert.match(restore, /--drill/);
  assert.match(restore, /--promote/);
  assert.match(restore, /DRILL mode: the ACTIVE authority is never touched/);
  assert.match(
    restore,
    /PROMOTE mode: this REPLACES the active authority after verification/,
  );
  assert.match(restore, /ALTER DATABASE .* RENAME TO/);
  assert.match(restore, /psqlRename\(ACTIVE_DB, SAFETY_DB\)/);
  assert.match(restore, /psqlRename\(ISOLATED_DB, ACTIVE_DB\)/);
  assert.match(restore, /psqlRename\(SAFETY_DB, ACTIVE_DB\)/);
  assert.match(restore, /post-recovery execution write did not persist/);
  assert.match(restore, /DROP DATABASE IF EXISTS/);
  // Bounded safety copy: one pre-restore database, replaced per recovery
  // (never accumulated) — and only dropped inside the swap step AFTER deep
  // verification, never during the post-promotion gates.
  assert.match(restore, /DROP DATABASE IF EXISTS \$\{SAFETY_DB\}/);
  assert.match(restore, /never accumulated/);
  // The renames are explicitly NOT transactionally atomic — the state
  // machine is what makes the swap failure-safe.
  assert.match(restore, /ALTER DATABASE \.\.\. RENAME inside a transaction/);
  // Non-claims stay documented.
  assert.match(restore, /runtime auth is never restored/);
});

test("backup manifest records release AND source identity plus bounded snapshot anchors", async () => {
  const backup = readFileSync(
    join(ROOT, "scripts", "self-hosted", "backup.mjs"),
    "utf8",
  );
  const { buildManifest } = await awaitImport("../self-hosted/backup.mjs");
  // The backup requires the immutable source revision — a backup without
  // source provenance cannot attest what it is.
  assert.match(backup, /TENVYR_SOURCE_REVISION to the full git commit SHA/);
  assert.match(backup, /git rev-parse HEAD/);
  const manifest = buildManifest(
    { version: "v0.1.0", checksum: "x", file: "f.dump" },
    {
      migrationLedgerFingerprint: "aa",
      tableCountFingerprint: "bb",
      planRevisionHashFingerprint: "cc",
      executionAnchor: "exec-1",
      capsuleAnchor: { executionId: "exec-1", exportIds: ["exp-1:hash"] },
    },
    "d".repeat(40),
  );
  assert.equal(manifest.version, "v0.1.0");
  assert.equal(manifest.sourceRevision, "d".repeat(40));
  // A manifest that exists is a VERIFIED backup: the marker is part of the
  // manifest contract, and the anchors are computed from an isolated
  // restore of the exact dump, never from the live database.
  assert.equal(manifest.verified, true);
  assert.match(manifest.verification, /dump-derived/);
  assert.deepEqual(manifest.anchors, {
    migrationLedgerFingerprint: "aa",
    tableCountFingerprint: "bb",
    planRevisionHashFingerprint: "cc",
    executionAnchor: "exec-1",
    capsuleAnchor: { executionId: "exec-1", exportIds: ["exp-1:hash"] },
  });
});

test("backup verifies the dump BEFORE labeling it a verified backup (dump-derived anchors, never live-DB anchors)", async () => {
  const backup = readFileSync(
    join(ROOT, "scripts", "self-hosted", "backup.mjs"),
    "utf8",
  );
  const { VERIFY_DB, REQUIRED_ANCHOR_KEYS } = await awaitImport(
    "../self-hosted/backup.mjs",
  );
  assert.equal(VERIFY_DB, "tenvyr_backup_verify");
  assert.deepEqual(REQUIRED_ANCHOR_KEYS, [
    "migrationLedgerFingerprint",
    "tableCountFingerprint",
    "planRevisionHashFingerprint",
  ]);
  // The dump is restored into the isolated verification database and the
  // anchors are computed FROM THAT RESTORED DUMP.
  assert.match(backup, /pg_restore/);
  assert.match(backup, /VERIFY_DB/);
  assert.match(backup, /snapshotAnchors\(psqlFor\(VERIFY_DB\), VERIFY_DB\)/);
  // The verified artifact is finalized (renamed + manifest + checksum)
  // ONLY after the restored dump is proven structurally valid.
  assert.match(backup, /renameSync\(stagingPath, finalPath\)/);
  const finalizeIndex = backup.indexOf("renameSync(stagingPath, finalPath)");
  const anchorsIndex = backup.indexOf(
    "snapshotAnchors(psqlFor(VERIFY_DB), VERIFY_DB)",
  );
  assert.ok(
    anchorsIndex >= 0 && anchorsIndex < finalizeIndex,
    "anchors must be computed before finalizing",
  );
  // A failed verification removes the staging artifact and never prints PASS.
  assert.match(backup, /rmSync\(stagingPath/);
  assert.match(backup, /never labeled/);
  assert.match(backup, /reports PASS/);
  // The old live-DB-anchors-before-dump flow is gone.
  assert.ok(
    !backup.includes("captured immediately before"),
    "live-DB anchor capture must be gone",
  );
});

test("snapshot anchors are deterministic and manifest-relative comparison fails closed on tamper", async () => {
  const { fingerprint, snapshotAnchors, compareAnchors, TABLES } =
    await awaitImport("../self-hosted/anchors.mjs");
  assert.equal(fingerprint("same"), fingerprint("same"));
  assert.ok(fingerprint("same") !== fingerprint("different"));
  // Fake runner over a canned database: one line per query result.
  const run = (sql) => {
    if (sql.includes("string_agg(name"))
      return { status: 0, stdout: "m1|m2\n" };
    if (sql.includes("count(*) FROM")) {
      // One count per inventory table, in order.
      return {
        status: 0,
        stdout: `${TABLES.map((_, i) => i + 1).join("|")}\n`,
      };
    }
    if (sql.includes('string_agg("planHash"'))
      return { status: 0, stdout: "h1|h2\n" };
    if (sql.includes('ORDER BY "createdAt"'))
      return { status: 0, stdout: "exec-1\n" };
    if (sql.includes('ORDER BY "updatedAt"'))
      return { status: 0, stdout: "exec-9\n" };
    if (sql.includes("execution_exports"))
      return { status: 0, stdout: "exp-1:abc|exp-2:def\n" };
    return { status: 1, stdout: "" };
  };
  const anchors = snapshotAnchors(run, "tenvyr");
  assert.equal(anchors.migrationLedgerFingerprint, fingerprint("m1|m2"));
  assert.equal(
    anchors.tableCountFingerprint,
    fingerprint(TABLES.map((t, i) => `${t}:${i + 1}`).join(",")),
  );
  assert.equal(anchors.planRevisionHashFingerprint, fingerprint("h1|h2"));
  assert.equal(anchors.executionAnchor, "exec-1");
  assert.deepEqual(anchors.capsuleAnchor, {
    executionId: "exec-9",
    exportIds: ["exp-1:abc", "exp-2:def"],
  });
  // Identical snapshot -> PASS.
  assert.deepEqual(compareAnchors(anchors, { ...anchors }), []);
  // Tampered restored snapshot -> violation.
  const tampered = {
    ...anchors,
    tableCountFingerprint: fingerprint("0"),
    executionAnchor: "other",
  };
  const violations = compareAnchors(anchors, tampered);
  assert.equal(violations.length, 2);
  assert.match(violations.join(" "), /tableCountFingerprint mismatch/);
  assert.match(violations.join(" "), /executionAnchor mismatch/);
  // A manifest without anchors fails closed (old backup).
  assert.match(
    compareAnchors({ version: "v0.0.1" }, anchors)[0],
    /predates snapshot anchors/,
  );
});

test("restore verifies the RESTORED snapshot against the BACKUP MANIFEST — the current active database is not the authority", async () => {
  const raw = readFileSync(
    join(ROOT, "scripts", "self-hosted", "restore.mjs"),
    "utf8",
  );
  // Normalize block-comment prefixes so prose assertions are line-break tolerant.
  const restore = raw.replace(/^\s*\*\s?/gm, "");
  // The manifest anchors are the authority; drift vs the current authority
  // is informational evidence only.
  assert.match(restore, /compareAnchors\(manifest\.anchors, restoredAnchors\)/);
  assert.match(restore, /CURRENT\s+active database is NOT the authority/i);
  assert.match(restore, /driftVsCurrent/);
  assert.match(restore, /informational only/);
  assert.match(restore, /predates snapshot anchors/);
  // The old authority model is gone: no active-vs-restored row-count
  // equality, no active-vs-restored plan-hash comparison.
  assert.ok(
    !restore.includes("row count mismatch for"),
    "active-vs-restored row counts must not be a restore requirement",
  );
  assert.ok(
    !restore.includes("activeHashes"),
    "active-vs-restored plan hashes must not be a restore requirement",
  );
  assert.ok(
    !restore.includes("activeExecution"),
    "active-vs-restored execution identity must not be a restore requirement",
  );
});

test("the disposable recovery E2E is wired and refuses real infrastructure", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(
    pkg.scripts["self-hosted:recovery-test"],
    /scripts\/self-hosted\/recovery\.test\.mjs/,
  );
  const recovery = readFileSync(
    join(ROOT, "scripts", "self-hosted", "recovery.test.mjs"),
    "utf8",
  );
  // The test must refuse to run against a real deployment.
  assert.match(recovery, /refus|must not be running|already running/);
  // It must exercise the full historical-recovery loop.
  assert.match(recovery, /state A/i);
  assert.match(recovery, /state B/i);
  assert.match(recovery, /--drill/);
  assert.match(recovery, /--promote/);
  assert.match(recovery, /post-recovery/);
  assert.match(recovery, /disposable/);
});

test("the canonical backup inventory matches the authoritative entity/schema inventory", async () => {
  const { TABLES } = await awaitImport("../self-hosted/anchors.mjs");
  const { readdirSync } = await import("node:fs");
  // Authoritative source 1: the TypeORM entity inventory.
  const entitiesDir = join(ROOT, "services", "orchestrator", "src", "entities");
  const entityTables = [];
  for (const file of readdirSync(entitiesDir).filter((name) =>
    name.endsWith(".entity.ts"),
  )) {
    const source = readFileSync(join(entitiesDir, file), "utf8");
    const match = source.match(/@Entity\("([a-z_]+)"\)/);
    assert.ok(match, `entity ${file} must declare a table name`);
    entityTables.push(match[1]);
  }
  // Authoritative source 2: the migration CREATE TABLE inventory (spec
  // files in the migrations directory are fixtures, not schema).
  const migrationsDir = join(
    ROOT,
    "services",
    "orchestrator",
    "src",
    "database",
    "migrations",
  );
  const migrationTables = new Set();
  for (const file of readdirSync(migrationsDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"),
  )) {
    const source = readFileSync(join(migrationsDir, file), "utf8");
    for (const match of source.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/g,
    )) {
      migrationTables.add(match[1]);
    }
  }
  const entitySet = new Set(entityTables);
  assert.equal(
    entitySet.size,
    entityTables.length,
    "duplicate entity table names",
  );
  const backupSet = new Set(TABLES);
  // The backup inventory must equal the entity inventory exactly — a
  // future application authority table cannot silently be omitted.
  const missingFromBackup = [...entitySet].filter(
    (table) => !backupSet.has(table),
  );
  assert.deepEqual(
    missingFromBackup,
    [],
    "entity tables missing from the backup inventory",
  );
  const extraInBackup = [...backupSet].filter((table) => !entitySet.has(table));
  assert.deepEqual(
    extraInBackup,
    [],
    "backup inventory entries with no entity",
  );
  // The migration schema must contain exactly the same Tenvyr-owned tables
  // (the `migrations` framework table is created by TypeORM at runtime,
  // never in the migration files, and is not Tenvyr-owned coverage).
  const migrationEntityOnly = [...migrationTables].filter(
    (table) => !entitySet.has(table),
  );
  assert.deepEqual(
    migrationEntityOnly,
    [],
    "unexpected non-entity schema tables",
  );
  // Spot-check tables across the closures (M0-M11 + PP1).
  assert.ok(backupSet.has("pipelines"));
  assert.ok(backupSet.has("plan_proposals"));
  assert.ok(backupSet.has("workspace_executions"));
  assert.ok(backupSet.has("handoffs"));
  assert.equal(TABLES.length, 35);
});

test("restore verifies BEFORE quiescing and swaps via a rollback-capable state machine", async () => {
  const restore = readFileSync(
    join(ROOT, "scripts", "self-hosted", "restore.mjs"),
    "utf8",
  );
  // Deep manifest-relative verification is a pre-quiesce step in promote
  // (the quiesce() FUNCTION DEFINITION appears earlier in the file, so the
  // assertion anchors on the promote call site).
  const deepIndex = restore.indexOf("deepIntegrityChecks(manifest)");
  const quiesceIndex = restore.indexOf("// 3. Quiesce writers");
  assert.ok(deepIndex >= 0 && quiesceIndex >= 0);
  assert.ok(
    deepIndex < quiesceIndex,
    "deep verification must run BEFORE quiescing",
  );
  assert.match(restore, /verified backup \(pre-quiesce\)/);
  // The swap is a deterministic state machine with automatic rollback.
  assert.match(restore, /swapAuthority/);
  assert.match(restore, /rolled-back/);
  assert.match(restore, /rollback-failed/);
  assert.match(restore, /renameSafetyToActive/);
  // Quiesce partial failure restarts both services before failing.
  assert.match(restore, /quiesce failed/);
  assert.match(restore, /services restarted/);
  // Malformed manifests fail cleanly BEFORE quiescing.
  assert.match(restore, /malformed backup manifest/);
  const malformedIndex = restore.indexOf("malformed backup manifest");
  assert.ok(
    malformedIndex < quiesceIndex,
    "manifest corruption must fail before quiescing",
  );
});

test("swapAuthority state machine: deterministic rollback on second-rename failure", async () => {
  const { swapAuthority } = await awaitImport("../self-hosted/restore.mjs");
  const okSteps = {
    dropSafety: () => ({ ok: true }),
    renameActiveToSafety: () => ({ ok: true }),
    renameVerifiedToActive: () => ({ ok: true }),
    renameSafetyToActive: () => ({ ok: true }),
  };
  assert.deepEqual(swapAuthority(okSteps), { ok: true, phase: "swapped" });
  // First rename fails: nothing was mutated.
  const firstFail = swapAuthority({
    ...okSteps,
    renameActiveToSafety: () => ({ ok: false, error: "boom" }),
  });
  assert.equal(firstFail.ok, false);
  assert.equal(firstFail.phase, "active-to-safety");
  // Second rename fails -> rollback succeeds: original authority restored.
  const rolledBack = swapAuthority({
    ...okSteps,
    renameVerifiedToActive: () => ({ ok: false, error: "second boom" }),
  });
  assert.equal(rolledBack.ok, false);
  assert.equal(rolledBack.phase, "rolled-back");
  assert.equal(rolledBack.reason, "second boom");
  // Second rename fails AND rollback fails: rollback-failed, both errors.
  const failed = swapAuthority({
    ...okSteps,
    renameVerifiedToActive: () => ({ ok: false, error: "second boom" }),
    renameSafetyToActive: () => ({ ok: false, error: "rollback boom" }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.phase, "rollback-failed");
  assert.equal(failed.reason, "second boom");
  assert.equal(failed.rollbackError, "rollback boom");
  // Drop-safety failure aborts before any rename.
  const dropFail = swapAuthority({
    ...okSteps,
    dropSafety: () => ({ ok: false, error: "drop boom" }),
  });
  assert.equal(dropFail.phase, "drop-safety");
});

test("rollbackPostPromotion state machine: restored active -> failed state, safety -> active", async () => {
  const { rollbackPostPromotion } = await awaitImport(
    "../self-hosted/restore.mjs",
  );
  const okSteps = {
    renameActiveToFailed: () => ({ ok: true }),
    renameSafetyToActive: () => ({ ok: true }),
  };
  assert.deepEqual(rollbackPostPromotion(okSteps), {
    ok: true,
    phase: "rolled-back",
  });
  const firstFail = rollbackPostPromotion({
    ...okSteps,
    renameActiveToFailed: () => ({ ok: false, error: "boom" }),
  });
  assert.equal(firstFail.ok, false);
  assert.equal(firstFail.phase, "active-to-failed");
  const secondFail = rollbackPostPromotion({
    ...okSteps,
    renameSafetyToActive: () => ({ ok: false, error: "boom" }),
  });
  assert.equal(secondFail.ok, false);
  assert.equal(secondFail.phase, "safety-to-active");
});

test("upgrade refuses deployment mutation after backup verification failure", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-upgrade-regression-"));
  try {
    const fakeGit = join(dir, "fake-git.sh");
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash\ncase "\${1} \${2}" in\n  "rev-parse --verify") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;\n  "rev-parse HEAD") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;\nesac\nexit 0\n`,
    );
    chmodSync(fakeGit, 0o755);
    const fakeBackup = join(dir, "fake-backup.sh");
    writeFileSync(
      fakeBackup,
      `#!/usr/bin/env bash\necho "[backup] FAIL: injected backup verification failure" >&2\nexit 1\n`,
    );
    chmodSync(fakeBackup, 0o755);
    const deployEnv = join(dir, "deploy.env");
    writeFileSync(
      deployEnv,
      `TENVYR_VERSION=v0.0.1\nPOSTGRES_PASSWORD=test\nTENVYR_SOURCE_REVISION=${"a".repeat(40)}\n`,
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/self-hosted/upgrade.mjs", "v0.1.0"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          TENVYR_DEPLOY_ENV: deployEnv,
          TENVYR_GIT_CMD: fakeGit,
          TENVYR_UPGRADE_BACKUP_CMD: fakeBackup,
        },
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.notEqual(
      result.status,
      0,
      "upgrade must fail when the verified backup fails",
    );
    assert.match(output, /verified backup did not complete/);
    assert.ok(
      !output.includes("[upgrade] building"),
      "compose build must never be reached",
    );
    assert.ok(
      !output.includes("resolving compose"),
      "compose resolution must never be reached",
    );
    assert.ok(
      !output.includes("upgrade] OK"),
      "no success output after backup failure",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hosted CI wires real PostgreSQL twice, the self-hosted contract gate, and the recovery E2E", async () => {
  const ci = readFileSync(
    join(ROOT, ".github", "workflows", "release-ci.yml"),
    "utf8",
  );
  // Real PostgreSQL job on disposable infrastructure: env set + suite TWICE.
  assert.match(ci, /postgres-integration:/);
  assert.match(
    ci,
    /TEST_DATABASE_URL: postgres:\/\/postgres:postgres@localhost:5432\/tenvyr_roadmap_test/,
  );
  const suiteRuns = ci.match(/pnpm --filter orchestrator test -- --runInBand/g);
  assert.ok(
    suiteRuns && suiteRuns.length >= 2,
    "the real PostgreSQL suite must run TWICE",
  );
  // The no-silent-skip guard is wired and exists.
  assert.match(ci, /assert-jest-run/);
  assert.ok(
    existsSync(join(ROOT, "scripts", "assert-jest-run.mjs")),
    "assert-jest-run.mjs must exist",
  );
  // Self-hosted contract + recovery E2E jobs are required (no opt-outs).
  assert.match(ci, /self-hosted:contract-test/);
  assert.match(ci, /self-hosted:recovery-test/);
  assert.ok(
    !ci.includes("continue-on-error"),
    "required closure tests must not continue-on-error",
  );
  // Live provider/CLI gates stay opt-in in hosted CI.
  assert.match(ci, /TENVYR_LIVE_RUNTIME_GATES: "0"/);
});

test("maintenance lock: exclusive ownership, fail-fast live contention, and FAIL-CLOSED stale/uncertain state", async () => {
  const {
    acquireMaintenanceLock,
    releaseMaintenanceLock,
    clearStaleMaintenanceLock,
    journalPath,
  } = await awaitImport("../self-hosted/maintenance.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // Isolate this test's maintenance state: the maintenance module resolves
  // its directory from TENVYR_MAINTENANCE_DIR at CALL time, so the
  // production <repo>/backups files are never touched.
  const maintenanceDir = mkdtempSync(join(tmpdir(), "tenvyr-lock-spec-"));
  const previousDir = process.env.TENVYR_MAINTENANCE_DIR;
  process.env.TENVYR_MAINTENANCE_DIR = maintenanceDir;
  const lockPath = join(maintenanceDir, ".maintenance.lock");
  try {
    const first = acquireMaintenanceLock();
    assert.equal(first.owned, true, "first acquisition must own the lock");
    assert.ok(
      existsSync(lockPath) &&
        !existsSync(join(ROOT, "backups", ".maintenance.lock")),
      "the lock must be created ONLY inside TENVYR_MAINTENANCE_DIR",
    );
    // A second acquisition while the owner is ALIVE fails fast.
    const second = acquireMaintenanceLock();
    assert.equal(
      second.owned,
      false,
      "second acquisition must not own the lock",
    );
    assert.equal(second.held, true);
    assert.equal(
      second.owner?.pid,
      process.pid,
      "the held lock must name the live owner",
    );
    assert.equal(
      second.denied,
      undefined,
      "live contention is not a stale-state denial",
    );
    releaseMaintenanceLock(first);
    // After release, acquisition succeeds again.
    const third = acquireMaintenanceLock();
    assert.equal(third.owned, true, "acquisition must succeed after release");
    releaseMaintenanceLock(third);
    // STALE owner (dead pid): FAIL CLOSED — never auto-reclaimed, because
    // a dead JS owner does not prove its docker/DB descendants are dead.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
      { flag: "wx" },
    );
    const stale = acquireMaintenanceLock();
    assert.equal(
      stale.owned,
      false,
      "a stale lock must NEVER be auto-reclaimed",
    );
    assert.match(stale.denied ?? "", /stale-maintenance-state/);
    assert.ok(
      (stale.instructions ?? []).length >= 4,
      "stale state must carry bounded operator instructions",
    );
    assert.ok(
      existsSync(lockPath),
      "the stale lock must still exist (never deleted)",
    );
    // Explicit operator clear refuses a LIVE owner...
    rmSync(lockPath, { force: true });
    const live = acquireMaintenanceLock();
    assert.equal(live.owned, true);
    const liveClear = clearStaleMaintenanceLock();
    assert.equal(
      liveClear.cleared,
      false,
      "the clear must refuse a live owner",
    );
    releaseMaintenanceLock(live);
    // ...and the explicit clear works for a dead owner.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
      { flag: "wx" },
    );
    const cleared = clearStaleMaintenanceLock();
    assert.equal(
      cleared.cleared,
      true,
      "explicit stale-lock clear must succeed for a dead owner",
    );
    assert.ok(
      !existsSync(lockPath),
      "the stale lock must be gone after the explicit clear",
    );
    const after = acquireMaintenanceLock();
    assert.equal(
      after.owned,
      true,
      "acquisition must succeed after the explicit clear",
    );
    releaseMaintenanceLock(after);
    // UNREADABLE owner record: FAIL CLOSED.
    writeFileSync(lockPath, "\x00\x01broken", "utf8");
    const unreadable = acquireMaintenanceLock();
    assert.equal(
      unreadable.owned,
      false,
      "an unreadable lock must never be acquired",
    );
    assert.ok(existsSync(lockPath), "the unreadable lock must still exist");
    rmSync(lockPath, { force: true });
  } finally {
    releaseMaintenanceLock({ owned: true });
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(maintenanceDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (previousDir === undefined) {
      delete process.env.TENVYR_MAINTENANCE_DIR;
    } else {
      process.env.TENVYR_MAINTENANCE_DIR = previousDir;
    }
  }
  assert.ok(journalPath().endsWith(".recovery-journal.json"));
});

test("recovery E2E guard: FAKE docker reporting real infrastructure -> ZERO destructive cleanup, production maintenance state BYTE-IDENTICAL", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-fake-docker-"));
  const logPath = join(dir, "docker.log");
  const psOutput = join(dir, "ps-a.txt");
  const volumeOutput = join(dir, "volumes.json");
  // Production-like maintenance sentinels: the refused suite must leave
  // them BYTE-IDENTICAL (never deleted, never overwritten).
  const productionLock = join(ROOT, "backups", ".maintenance.lock");
  const productionJournal = join(ROOT, "backups", ".recovery-journal.json");
  const lockSentinel = JSON.stringify({
    pid: 999_999_999,
    startedAt: "sentinel-lock",
  });
  const journalSentinel = JSON.stringify({
    operation: "promote",
    phase: "complete",
    backup: "sentinel-journal",
    startedAt: "sentinel",
    updatedAt: "sentinel",
  });
  try {
    writeFileSync(productionLock, lockSentinel, "utf8");
    writeFileSync(productionJournal, journalSentinel, "utf8");
    // Scenario 1: docker ps -a reports REAL Tenvyr infrastructure (a
    // STOPPED production container — ps -a shows stopped containers).
    writeFileSync(psOutput, "tenvyr-self-hosted-postgres\n", "utf8");
    writeFileSync(volumeOutput, "", "utf8");
    const fakeDocker = join(dir, "docker");
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash\necho "$*" >> "$TENVYR_FAKE_DOCKER_LOG"\ncase "$1" in\n  ps) cat "$TENVYR_FAKE_DOCKER_PSA" ;;\n  volume) cat "$TENVYR_FAKE_DOCKER_VOLUMES" ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(fakeDocker, 0o755);
    // node:test marks its own test-file children with NODE_TEST_CONTEXT;
    // the spawned SUITE must not inherit it (it would skip running).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const suite = spawnSync(
      process.execPath,
      ["--test", "scripts/self-hosted/recovery.test.mjs"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...childEnv,
          PATH: `${dir}:${childEnv.PATH ?? ""}`,
          TENVYR_FAKE_DOCKER_LOG: logPath,
          TENVYR_FAKE_DOCKER_PSA: psOutput,
          TENVYR_FAKE_DOCKER_VOLUMES: volumeOutput,
        },
      },
    );
    assert.notEqual(
      suite.status,
      0,
      `the suite must refuse to run when real infrastructure is present: status=${suite.status} out=${(suite.stdout ?? "").slice(-600)} err=${(suite.stderr ?? "").slice(-600)}`,
    );
    assert.match(suite.stdout + suite.stderr, /refusing to run/);
    const log = readFileSync(logPath, "utf8");
    assert.ok(
      !log.includes("compose"),
      `the teardown must NEVER run compose against the production project: ${log}`,
    );
    assert.ok(
      !log.includes("down") &&
        !log.includes("volume rm") &&
        !log.includes("rm "),
      `no destructive cleanup may run after a guard failure: ${log}`,
    );
    // Production maintenance state: UNTOUCHED (byte-identical).
    assert.equal(
      readFileSync(productionLock, "utf8"),
      lockSentinel,
      "the production maintenance lock must survive a refused suite byte-identical",
    );
    assert.equal(
      readFileSync(productionJournal, "utf8"),
      journalSentinel,
      "the production recovery journal must survive a refused suite byte-identical",
    );
    // Scenario 2: the real production VOLUME exists (preserved volume,
    // no running container) — also refused, also zero cleanup, also
    // byte-identical sentinels.
    const psOutput2 = join(dir, "ps-a2.txt");
    const volumeOutput2 = join(dir, "volumes2.json");
    writeFileSync(psOutput2, "", "utf8");
    writeFileSync(
      volumeOutput2,
      JSON.stringify({
        Name: "tenvyr-self-hosted_tenvyr_postgres_data",
        Driver: "local",
        Scope: "local",
      }) + "\n",
      "utf8",
    );
    const logPath2 = join(dir, "docker2.log");
    const suite2 = spawnSync(
      process.execPath,
      ["--test", "scripts/self-hosted/recovery.test.mjs"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...childEnv,
          PATH: `${dir}:${childEnv.PATH ?? ""}`,
          TENVYR_FAKE_DOCKER_LOG: logPath2,
          TENVYR_FAKE_DOCKER_PSA: psOutput2,
          TENVYR_FAKE_DOCKER_VOLUMES: volumeOutput2,
        },
      },
    );
    assert.notEqual(
      suite2.status,
      0,
      "the suite must refuse when the real production volume exists",
    );
    assert.match(suite2.stdout + suite2.stderr, /refusing to run/);
    const log2 = readFileSync(logPath2, "utf8");
    assert.ok(
      !log2.includes("compose"),
      `zero compose actions after a volume guard failure: ${log2}`,
    );
    assert.equal(
      readFileSync(productionLock, "utf8"),
      lockSentinel,
      "the production maintenance lock must survive the volume guard failure byte-identical",
    );
    assert.equal(
      readFileSync(productionJournal, "utf8"),
      journalSentinel,
      "the production recovery journal must survive the volume guard failure byte-identical",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(productionLock, { force: true });
    rmSync(productionJournal, { force: true });
  }
});

test("freeFailedPromotionName: a preserved candidate is never overwritten; rollback renames never collide", async () => {
  const { freeFailedPromotionName, FAILED_PROMOTION_DB } = await awaitImport(
    "../self-hosted/maintenance.mjs",
  );
  assert.equal(freeFailedPromotionName([]), FAILED_PROMOTION_DB);
  assert.equal(
    freeFailedPromotionName([FAILED_PROMOTION_DB]),
    `${FAILED_PROMOTION_DB}_1`,
    "a colliding preserved candidate must yield a non-colliding name",
  );
  assert.equal(
    freeFailedPromotionName([
      FAILED_PROMOTION_DB,
      `${FAILED_PROMOTION_DB}_1`,
      `${FAILED_PROMOTION_DB}_2`,
    ]),
    `${FAILED_PROMOTION_DB}_3`,
  );
  assert.throws(
    () =>
      freeFailedPromotionName(
        Array.from({ length: 101 }, (_, i) =>
          i === 0 ? FAILED_PROMOTION_DB : `${FAILED_PROMOTION_DB}_${i}`,
        ),
      ),
    /no free failed-promotion name available/,
  );
});

test("stale-owner FAIL-CLOSED process tree: owner SIGKILL with a live docker child → DENIED until the child is gone and the lock is explicitly cleared", async () => {
  const { spawn, spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-proc-tree-"));
  const isPidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "ESRCH" ? false : true;
    }
  };
  try {
    // FAKE long-running docker executable: records its PID and STAYS
    // ALIVE — the real external-process boundary the maintenance owner
    // drives (docker exec / pg_dump / pg_restore / psql descendants).
    const pidFile = join(dir, "docker.pid");
    const fakeDocker = join(dir, "docker");
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash\necho $$ > "$TENVYR_FAKE_DOCKER_PIDFILE"\nwhile true; do sleep 1; done\n`,
    );
    chmodSync(fakeDocker, 0o755);
    const maintenanceDir = join(dir, "maint");
    const deployEnv = join(dir, "deploy.env");
    writeFileSync(
      deployEnv,
      `TENVYR_VERSION=v0.1.0\nTENVYR_SOURCE_REVISION=${"a".repeat(40)}\nPOSTGRES_PASSWORD=test\n`,
    );
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      TENVYR_FAKE_DOCKER_PIDFILE: pidFile,
      TENVYR_MAINTENANCE_DIR: maintenanceDir,
      TENVYR_DEPLOY_ENV: deployEnv,
    };
    delete env.NODE_TEST_CONTEXT;
    const acquireResult = (label) => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import("file://${join(ROOT, "scripts", "self-hosted", "maintenance.mjs")}").then((m) => {
  const lock = m.acquireMaintenanceLock();
  console.log("RESULT " + JSON.stringify({ owned: lock.owned, denied: lock.denied ?? null }));
  if (lock.owned) m.releaseMaintenanceLock(lock);
});`,
        ],
        { cwd: ROOT, encoding: "utf8", env },
      );
      const line = (result.stdout ?? "")
        .split("\n")
        .find((l) => l.startsWith("RESULT "));
      assert.ok(
        line,
        `${label}: the acquire child must report a result: ${result.stdout}\n${result.stderr}`,
      );
      return JSON.parse(line.slice("RESULT ".length));
    };
    // 1. The REAL backup process acquires the REAL maintenance lock and
    //    reaches spawnSync("docker", ...) — the fake docker records its
    //    PID and stays alive.
    const backup = spawn(process.execPath, ["scripts/self-hosted/backup.mjs"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let backupOutput = "";
    backup.stdout.on("data", (d) => (backupOutput += d));
    backup.stderr.on("data", (d) => (backupOutput += d));
    const spawnDeadline = Date.now() + 30_000;
    while (
      !existsSync(pidFile) &&
      Date.now() < spawnDeadline &&
      backup.exitCode === null
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      existsSync(pidFile),
      `the fake docker child must have been spawned by the real backup; output: ${backupOutput.slice(-400)}`,
    );
    const dockerPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    assert.ok(
      Number.isInteger(dockerPid) && dockerPid > 0,
      "the fake docker must record a real PID",
    );
    // 2. SIGKILL the maintenance owner (the backup Node process).
    backup.kill("SIGKILL");
    await new Promise((resolve) => backup.once("close", resolve));
    // 3. The docker child SURVIVES the owner's death (kill does not
    //    propagate to the external child).
    assert.ok(
      isPidAlive(dockerPid),
      "the docker child must remain alive after the owner's SIGKILL",
    );
    // 4. A second REAL acquisition is DENIED — stale/uncertain
    //    maintenance state (the dead owner does not prove the docker
    //    descendant is dead).
    const denied = acquireResult("second acquisition");
    assert.equal(
      denied.owned,
      false,
      "the second acquisition MUST be denied while the docker child survives",
    );
    assert.match(denied.denied ?? "", /stale-maintenance-state/);
    assert.ok(
      existsSync(join(maintenanceDir, ".maintenance.lock")),
      "the stale lock must still exist after the denial",
    );
    // 5. Terminate the surviving docker child (the operator's bounded
    //    confirmation step) — then the EXPLICIT stale-lock clear allows
    //    acquisition again.
    try {
      process.kill(dockerPid, "SIGKILL");
    } catch {
      // already gone
    }
    const goneDeadline = Date.now() + 10_000;
    while (isPidAlive(dockerPid) && Date.now() < goneDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      !isPidAlive(dockerPid),
      "the docker child must be terminated before the explicit clear",
    );
    const clear = spawnSync(
      process.execPath,
      ["scripts/self-hosted/maintenance.mjs", "--clear-stale-lock"],
      { cwd: ROOT, encoding: "utf8", env },
    );
    assert.equal(
      clear.status,
      0,
      `the explicit stale-lock clear must succeed: ${clear.stdout}\n${clear.stderr}`,
    );
    const acquired = acquireResult("post-clear acquisition");
    assert.equal(
      acquired.owned,
      true,
      "acquisition must succeed after the explicit clear",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade runs the REAL verified backup IN-PROCESS; owner SIGKILL → stale lock is DENIED until the explicit clear", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-upgrade-real-backup-"));
  const maintenanceDir = join(dir, "maint");
  const lockPath = join(maintenanceDir, ".maintenance.lock");
  const previousDir = process.env.TENVYR_MAINTENANCE_DIR;
  process.env.TENVYR_MAINTENANCE_DIR = maintenanceDir;
  try {
    const fakeGit = join(dir, "fake-git.sh");
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash\ncase "\${1} \${2}" in\n  "rev-parse --verify") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;\n  "rev-parse HEAD") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;\nesac\nexit 0\n`,
    );
    chmodSync(fakeGit, 0o755);
    const deployEnv = join(dir, "deploy.env");
    writeFileSync(
      deployEnv,
      `TENVYR_VERSION=v0.0.1\nPOSTGRES_PASSWORD=test\nTENVYR_SOURCE_REVISION=${"a".repeat(40)}\n`,
    );
    // The upgrade invokes the REAL backup.mjs runVerifiedBackup IN THE
    // SAME PROCESS while holding the maintenance lock — there is no
    // upgrade->backup child, so NOTHING that uses the shared maintenance
    // resources can survive the owner's death. The backup fails only at
    // the unavailable self-hosted postgres (proving it ran past the
    // lock, which the owner process itself holds).
    const child = spawn(
      process.execPath,
      ["scripts/self-hosted/upgrade.mjs", "v0.1.0"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          TENVYR_DEPLOY_ENV: deployEnv,
          TENVYR_GIT_CMD: fakeGit,
          TENVYR_MAINTENANCE_DIR: maintenanceDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let killed = false;
    const killPromise = new Promise((resolve) => {
      child.stdout.on("data", (d) => {
        output += d;
        if (output.includes("taking VERIFIED backup") && !killed) {
          killed = true;
          // SIGKILL the owner MID-BACKUP: the crash-linearizability
          // property under test.
          child.kill("SIGKILL");
          resolve({ killed: true });
        }
      });
      child.stderr.on("data", (d) => {
        output += d;
      });
    });
    const exitPromise = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    const killDone = await Promise.race([
      killPromise,
      exitPromise.then(() => ({ timedOut: true })),
    ]);
    const exit = await exitPromise;
    if (killDone.timedOut) {
      // The backup failed before the kill landed — the upgrade exited
      // normally; the ORPHAN-PROOF still holds (nothing was ever forked).
      assert.notEqual(
        exit.code,
        0,
        "the upgrade must fail (the real backup cannot reach the postgres)",
      );
      assert.match(output, /verified backup did not complete/);
    } else {
      assert.equal(
        exit.signal,
        "SIGKILL",
        "the owner must die by SIGKILL mid-backup",
      );
    }
    // FAIL-CLOSED STALE-OWNER POLICY: the dead owner's lock is NEVER
    // auto-reclaimed — a dead JS owner does not prove its external
    // maintenance children (docker/DB) are dead.
    const {
      acquireMaintenanceLock,
      releaseMaintenanceLock,
      clearStaleMaintenanceLock,
    } = await awaitImport("../self-hosted/maintenance.mjs");
    const after = acquireMaintenanceLock();
    assert.equal(
      after.owned,
      false,
      "the stale lock from the dead owner must NOT be auto-reclaimed",
    );
    assert.match(after.denied ?? "", /stale-maintenance-state/);
    assert.ok(
      existsSync(lockPath),
      "the stale lock must still exist after the denial",
    );
    // The explicit operator clear (dead owner) then allows acquisition.
    const cleared = clearStaleMaintenanceLock();
    assert.equal(
      cleared.cleared,
      true,
      "the explicit stale-lock clear must succeed for the dead owner",
    );
    const afterwards = acquireMaintenanceLock();
    assert.equal(
      afterwards.owned,
      true,
      "acquisition must succeed after the explicit clear",
    );
    releaseMaintenanceLock(afterwards);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort
    }
    if (previousDir === undefined) {
      delete process.env.TENVYR_MAINTENANCE_DIR;
    } else {
      process.env.TENVYR_MAINTENANCE_DIR = previousDir;
    }
  }
});

test("planReconciliation: every crash phase maps to a deterministic, never-destructive action", async () => {
  const { planReconciliation, ACTIVE_DB, SAFETY_DB, ISOLATED_DB } =
    await awaitImport("../self-hosted/maintenance.mjs");
  const dbs = (extra) => [ACTIVE_DB, SAFETY_DB, ISOLATED_DB, ...extra];
  // VALID journal, complete -> proceed (durable completion evidence: the
  // retained safety copy is a completed-recovery artifact).
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "complete",
      databases: dbs([]),
    }).action,
    "proceed",
  );
  // VALID journal, crash after the first rename: original is the safety
  // copy; active is missing -> restore-original (NEVER dropped).
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "swap-verified-to-active",
      databases: [SAFETY_DB, ISOLATED_DB],
    }).action,
    "restore-original",
  );
  // VALID journal, crash after candidate promotion: tenvyr holds the
  // unproven candidate, safety holds the original -> rollback-candidate.
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "post-gates",
      databases: dbs([]),
    }).action,
    "rollback-candidate",
  );
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "swap-verified-to-active",
      databases: dbs([]),
    }).action,
    "rollback-candidate",
  );
  // VALID journal, crash before the first rename: "verify-done" (quiesce
  // never started — services running) -> proceed; "quiescing" and
  // "swap-active-to-safety" (writers may be stopped, original active) ->
  // restart-original (availability is never left broken).
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "verify-done",
      databases: dbs([]),
    }).action,
    "proceed",
  );
  for (const phase of ["quiescing", "swap-active-to-safety"]) {
    assert.equal(
      planReconciliation({ journalState: "valid", phase, databases: dbs([]) })
        .action,
      "restart-original",
      `valid phase ${phase} with active+safety must restart-original`,
    );
    assert.equal(
      planReconciliation({
        journalState: "valid",
        phase,
        databases: [ACTIVE_DB, ISOLATED_DB],
      }).action,
      "restart-original",
      `valid phase ${phase} with active+no-safety must restart-original`,
    );
  }
  // VALID journal, mid-reconciliation crash after the rename-back:
  // original active, no safety, services possibly still stopped ->
  // proceed WITH restartServices (the next invocation finishes the
  // restart before continuing).
  const midReconciliation = planReconciliation({
    journalState: "valid",
    phase: "swap-verified-to-active",
    databases: [ACTIVE_DB, ISOLATED_DB],
  });
  assert.equal(midReconciliation.action, "proceed");
  assert.equal(midReconciliation.restartServices, true);
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "post-gates",
      databases: [ACTIVE_DB, ISOLATED_DB],
    }).restartServices,
    true,
  );
  // VALID journal, no active AND no safety -> blocked.
  assert.equal(
    planReconciliation({
      journalState: "valid",
      phase: "swap-verified-to-active",
      databases: [ISOLATED_DB],
    }).action,
    "blocked",
  );

  // ABSENT/MALFORMED journal (evidence unusable) — the OBSERVED layout
  // decides CONSERVATIVELY; never a default proceed:
  //  - safety exists, active missing (first rename happened) -> the
  //    original is under the safety name -> restore-original, NEVER a
  //    path that can DROP safety.
  for (const journalState of ["absent", "malformed"]) {
    assert.equal(
      planReconciliation({ journalState, databases: [SAFETY_DB, ISOLATED_DB] })
        .action,
      "restore-original",
      `${journalState} journal with original-only-under-safety must restore-original`,
    );
    //  - active + safety: ambiguous (completed prior recovery vs
    //    uncommitted candidate) -> FAIL CLOSED, both copies preserved.
    assert.equal(
      planReconciliation({ journalState, databases: dbs([]) }).action,
      "blocked",
      `${journalState} journal with active+safety must block`,
    );
    //  - no active + no safety -> blocked.
    assert.equal(
      planReconciliation({ journalState, databases: [ISOLATED_DB] }).action,
      "blocked",
      `${journalState} journal with no active + no safety must block`,
    );
    //  - active + no safety -> clean state -> proceed.
    assert.equal(
      planReconciliation({ journalState, databases: [ACTIVE_DB, ISOLATED_DB] })
        .action,
      "proceed",
      `${journalState} journal with clean active layout must proceed`,
    );
  }
  // The original authority must never be dropped by any plan: every
  // non-proceed action renames the safety copy back or blocks.
  for (const outcome of [
    planReconciliation({
      journalState: "valid",
      phase: "post-gates",
      databases: dbs([]),
    }),
    planReconciliation({
      journalState: "valid",
      phase: "swap-verified-to-active",
      databases: [SAFETY_DB, ISOLATED_DB],
    }),
    planReconciliation({
      journalState: "absent",
      databases: [SAFETY_DB, ISOLATED_DB],
    }),
    planReconciliation({ journalState: "malformed", databases: dbs([]) }),
  ]) {
    assert.ok(
      ["restore-original", "rollback-candidate", "blocked"].includes(
        outcome.action,
      ),
    );
  }
});

test("recovery journal: atomic writes never fail open; completion evidence survives", async () => {
  const {
    writeJournal,
    readJournalState,
    readJournal,
    clearJournal,
    journalPath,
  } = await awaitImport("../self-hosted/maintenance.mjs");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // Isolate the journal in a temp maintenance directory — the production
  // <repo>/backups journal is never touched by the test suite.
  const maintenanceDir = mkdtempSync(join(tmpdir(), "tenvyr-journal-spec-"));
  const previousDir = process.env.TENVYR_MAINTENANCE_DIR;
  process.env.TENVYR_MAINTENANCE_DIR = maintenanceDir;
  const path = journalPath();
  try {
    // Every phase writes a complete, well-formed, immediately readable
    // record (temp+rename: no in-place truncation window).
    for (const phase of [
      "verify-done",
      "quiescing",
      "swap-active-to-safety",
      "swap-verified-to-active",
      "post-gates",
      "complete",
    ]) {
      writeJournal(phase, "backup.dump");
      const { state, journal } = readJournalState();
      assert.equal(state, "valid", `phase ${phase} must be read back as valid`);
      assert.equal(journal.phase, phase);
      assert.equal(
        readJournal().startedAt,
        journal.startedAt,
        "startedAt must be stable",
      );
    }
    // A leftover temp file (simulating a crash between the temp write and
    // the rename) must NEVER corrupt reads: the last valid record wins.
    writeJournal("post-gates", "backup.dump");
    writeFileSync(`${path}.tmp`, "{truncated garbage", "utf8");
    const afterTmp = readJournalState();
    assert.equal(afterTmp.state, "valid");
    assert.equal(afterTmp.journal.phase, "post-gates");
    // A malformed journal file is reported as "malformed" (evidence
    // unusable), never as a valid phase and never silently "absent".
    writeFileSync(path, "{not json", "utf8");
    assert.equal(readJournalState().state, "malformed");
    assert.equal(readJournal(), null);
    // Absent journal is reported as "absent".
    rmSync(path, { force: true });
    assert.equal(readJournalState().state, "absent");
    // Completion evidence lifecycle: a "complete" journal (retained
    // safety copy) must be preserved as the unambiguous completion
    // marker — clearing is explicit and only for resolved states.
    writeJournal("complete", "backup.dump");
    assert.equal(readJournalState().state, "valid");
    assert.equal(readJournalState().journal.phase, "complete");
  } finally {
    clearJournal();
    try {
      rmSync(`${journalPath()}.tmp`, { force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(maintenanceDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (previousDir === undefined) {
      delete process.env.TENVYR_MAINTENANCE_DIR;
    } else {
      process.env.TENVYR_MAINTENANCE_DIR = previousDir;
    }
  }
});

test("validateManifestContract fails closed on every corruption/tamper class", async () => {
  const { validateManifestContract, inventoryFingerprintValue } =
    await awaitImport("../self-hosted/anchors.mjs");
  const hash = (char) => char.repeat(64);
  const validManifest = {
    version: "v0.1.0",
    algorithm: "sha256",
    verified: true,
    sourceRevision: "a".repeat(40),
    checksum: "c".repeat(64),
    tables: inventoryFingerprintValue(),
    anchors: {
      migrationLedgerFingerprint: hash("1"),
      tableCountFingerprint: hash("2"),
      planRevisionHashFingerprint: hash("3"),
      executionAnchor: "exec-1",
      capsuleAnchor: null,
    },
  };
  const context = {
    manifest: validManifest,
    dumpChecksum: "c".repeat(64),
    sidecarChecksum: "c".repeat(64),
    TENVYR_VERSION: "v0.1.0",
  };
  // The valid manifest passes.
  assert.equal(validateManifestContract(context).version, "v0.1.0");
  // Checksum triple: ANY copy mismatch fails.
  assert.throws(
    () =>
      validateManifestContract({ ...context, dumpChecksum: "d".repeat(64) }),
    /checksum mismatch/,
  );
  assert.throws(
    () =>
      validateManifestContract({ ...context, sidecarChecksum: "d".repeat(64) }),
    /checksum mismatch/,
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, checksum: "d".repeat(64) },
      }),
    /checksum mismatch/,
  );
  // The manifest checksum is REQUIRED: missing, null, malformed, and
  // non-lowercase shapes all fail closed.
  const { checksum: _omit, ...withoutChecksum } = validManifest;
  assert.throws(
    () => validateManifestContract({ ...context, manifest: withoutChecksum }),
    /manifest checksum is missing or malformed/,
    "missing checksum must fail",
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, checksum: null },
      }),
    /manifest checksum is missing or malformed/,
    "null checksum must fail",
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, checksum: "not-a-checksum" },
      }),
    /manifest checksum is missing or malformed/,
    "malformed checksum must fail",
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, checksum: "C".repeat(64) },
      }),
    /manifest checksum is missing or malformed/,
    "non-lowercase checksum must fail",
  );
  // Missing manifest / missing verified marker.
  assert.throws(
    () => validateManifestContract({ ...context, manifest: null }),
    /manifest is missing/,
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, verified: undefined },
      }),
    /not a VERIFIED backup/,
  );
  // Required structural anchors: null and malformed shapes fail; optional
  // anchors may be null (empty database).
  for (const key of [
    "migrationLedgerFingerprint",
    "tableCountFingerprint",
    "planRevisionHashFingerprint",
  ]) {
    assert.throws(
      () =>
        validateManifestContract({
          ...context,
          manifest: {
            ...validManifest,
            anchors: { ...validManifest.anchors, [key]: null },
          },
        }),
      /required anchor/,
      `${key} null must fail`,
    );
    assert.throws(
      () =>
        validateManifestContract({
          ...context,
          manifest: {
            ...validManifest,
            anchors: { ...validManifest.anchors, [key]: "not-hex" },
          },
        }),
      /required anchor/,
      `${key} malformed must fail`,
    );
  }
  // Version / algorithm / sourceRevision / inventory shape.
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, version: "v9.9.9" },
      }),
    /does not match deployment/,
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, algorithm: "md5" },
      }),
    /unsupported backup checksum algorithm/,
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, sourceRevision: "short" },
      }),
    /sourceRevision must be a full git commit SHA/,
  );
  assert.throws(
    () =>
      validateManifestContract({
        ...context,
        manifest: { ...validManifest, tables: "some, other" },
      }),
    /inventory does not match/,
  );
});

test("invariants checks are executable: environment contract and pinned images", async () => {
  const { checkEnvironmentContract, checkPinnedImages } = await awaitImport(
    "../self-hosted/invariants.mjs",
  );
  assert.deepEqual(checkEnvironmentContract(COMPOSE), []);
  assert.deepEqual(checkPinnedImages(COMPOSE), []);
  // A floating tag is always flagged.
  assert.deepEqual(checkPinnedImages("  image: tenvyr-orchestrator:latest\n"), [
    'image "tenvyr-orchestrator:latest" is not pinned to a version',
  ]);
  // A legacy DATABASE_URL in the orchestrator block is always flagged.
  assert.ok(
    checkEnvironmentContract(
      '  orchestrator:\n    environment:\n      DATABASE_URL: postgres://x\n      ORCHESTRATOR_PORT: "3001"\n  gateway:\n',
    ).length > 0,
  );
});

test("package.json wires the advertised upgrade and invariants commands", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(
    pkg.scripts["self-hosted:upgrade"],
    /scripts\/self-hosted\/upgrade\.mjs/,
  );
  assert.match(
    pkg.scripts["self-hosted:invariants"],
    /scripts\/self-hosted\/invariants\.mjs/,
  );
});
