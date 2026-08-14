/**
 * M11-S1: the supported self-hosted deployment contract, as code.
 * Every assertion here pins the topology/version/trust/data contract
 * documented in docs/operations/self-hosted.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = readFileSync(join(ROOT, "docker-compose.self-hosted.yml"), "utf8");
const ENV_EXAMPLE = readFileSync(join(ROOT, ".env.self-hosted.example"), "utf8");

test("self-hosted profile binds loopback only (no public ports by default)", () => {
  const portLines = COMPOSE.split("\n").filter((line) => line.includes('"127.0.0.1:'));
  assert.ok(portLines.length >= 3, "expected postgres/orchestrator/gateway loopback bindings");
  const publicLines = COMPOSE.split("\n").filter((line) => /^\s+- "\d+:\d+"\s*$/.test(line));
  assert.equal(publicLines.length, 0, `public bindings present: ${publicLines.join(", ")}`);
});

test("self-hosted profile pins versions (no :latest floats)", () => {
  assert.ok(!COMPOSE.includes(":latest"), "floating :latest tag in the profile");
  assert.match(COMPOSE, /postgres:15-alpine/);
});

test("named volumes exist and hold the authority", () => {
  assert.match(COMPOSE, /tenvyr_postgres_data:/);
  assert.match(COMPOSE, /- tenvyr_postgres_data:\/var\/lib\/postgresql\/data/);
});

test("orchestrator/gateway consume ORCHESTRATOR_PORT/GATEWAY_PORT (never PORT)", () => {
  const orchestratorBlock = COMPOSE.split("\n").find((line) => line.includes("ORCHESTRATOR_PORT"));
  assert.ok(orchestratorBlock, "ORCHESTRATOR_PORT missing from the profile");
  assert.match(COMPOSE, /GATEWAY_PORT: "3000"/);
  for (const line of COMPOSE.split("\n")) {
    if (/^\s+PORT: /.test(line)) {
      assert.fail(`legacy PORT: assignment in the profile: ${line.trim()}`);
    }
  }
});

test("orchestrator consumes the POSTGRES_* contract with interpolated password", () => {
  const orchestratorIndex = COMPOSE.indexOf("container_name: tenvyr-self-hosted-orchestrator");
  const gatewayIndex = COMPOSE.indexOf("container_name: tenvyr-self-hosted-gateway");
  const orchestratorBlock = COMPOSE.slice(orchestratorIndex, gatewayIndex);
  assert.ok(orchestratorBlock.includes("POSTGRES_HOST: postgres"), "POSTGRES_HOST missing");
  assert.ok(orchestratorBlock.includes("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD"), "password not interpolated");
  assert.ok(!orchestratorBlock.includes("DATABASE_URL"), "dead DATABASE_URL in the profile");
  assert.ok(!orchestratorBlock.includes("REDIS_URL"), "unused REDIS_URL in the profile");
  assert.ok(!/^\s+PORT: /m.test(orchestratorBlock), "legacy PORT assignment in orchestrator env");
});

test("no unused redis service in the self-hosted profile", () => {
  assert.ok(!COMPOSE.includes("container_name: tenvyr-self-hosted-redis"), "unused redis still shipped");
  assert.ok(!COMPOSE.includes("tenvyr_redis_data"), "unused redis volume still shipped");
});

test("compose consumes secret REFERENCES only — no live values", () => {
  const suspicious = COMPOSE.split("\n").filter(
    (line) =>
      line.includes("PASSWORD") &&
      !line.includes("${") &&
      !line.includes("#") &&
      line.includes(":"),
  );
  assert.equal(suspicious.length, 0, `inline secrets in the profile: ${suspicious.join(", ")}`);
  assert.match(COMPOSE, /\$\{POSTGRES_PASSWORD:?/);
  assert.match(COMPOSE, /\$\{HTTP_AGENT_CALLBACK_KEYS:?/);
});

test(".env.self-hosted.example is references-only with no values", () => {
  for (const line of ENV_EXAMPLE.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const value = line.split("=").slice(1).join("=").trim();
    assert.ok(
      value === "" || value.startsWith("{") || value.startsWith("http") || value.startsWith("#"),
      `placeholder value leaked into example line: ${line}`,
    );
  }
  assert.match(ENV_EXAMPLE, /openssl rand -hex 32/);
});

test("data inventory matches the backup script's table list", () => {
  const anchors = readFileSync(join(ROOT, "scripts", "self-hosted", "anchors.mjs"), "utf8");
  const backup = readFileSync(join(ROOT, "scripts", "self-hosted", "backup.mjs"), "utf8");
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
  assert.match(backup, /TABLES\.join\(", "\)/);
});

test("restore verifies checksum and version before touching the target", () => {
  const restore = readFileSync(join(ROOT, "scripts", "self-hosted", "restore.mjs"), "utf8");
  assert.match(restore, /checksum mismatch — refusing to restore/);
  assert.match(restore, /backup version .* does not match deployment/);
  assert.match(restore, /DROP DATABASE IF EXISTS/);
  assert.match(restore, /tenvyr_restore/);
});

test("clean checkout is bootable: orchestrator and gateway declare build contexts", () => {
  const orchestratorIndex = COMPOSE.indexOf("container_name: tenvyr-self-hosted-orchestrator");
  const gatewayIndex = COMPOSE.indexOf("container_name: tenvyr-self-hosted-gateway");
  const orchestratorBlock = COMPOSE.slice(0, orchestratorIndex);
  assert.match(orchestratorBlock, /build:\n\s+context: \.\n\s+dockerfile: services\/orchestrator\/Dockerfile\n\s+target: production/);
  const gatewayBlock = COMPOSE.slice(orchestratorIndex, gatewayIndex);
  assert.match(gatewayBlock, /build:\n\s+context: \.\n\s+dockerfile: services\/gateway\/Dockerfile\n\s+target: production/);
  // The Dockerfiles the build contract points at exist.
  assert.ok(existsSync(join(ROOT, "services", "orchestrator", "Dockerfile")));
  assert.ok(existsSync(join(ROOT, "services", "gateway", "Dockerfile")));
});

test("upgrade validates target versions executably (supported shape, no downgrade, no no-op)", async () => {
  const { validateTargetVersion } = await awaitImport("../self-hosted/upgrade.mjs");
  assert.equal(validateTargetVersion("v0.4.2", "v0.3.1").ok, true);
  assert.equal(validateTargetVersion("v0.4.2", undefined).ok, true);
  assert.equal(validateTargetVersion("0.4.2", "v0.3.1").ok, false);
  assert.equal(validateTargetVersion("v0.4.2-beta.1", "v0.3.1").ok, false);
  assert.equal(validateTargetVersion("v0.2.0", "v0.3.1").ok, false);
  assert.equal(validateTargetVersion("v0.3.1", "v0.3.1").ok, false);
});

test("upgrade compares versions NUMERICALLY (major, then minor, then patch)", async () => {
  const { compareVersions, validateTargetVersion } = await awaitImport("../self-hosted/upgrade.mjs");
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
  const { expectedImageTags, resolvedTagsMatch, applyDeployedMetadata } = await awaitImport("../self-hosted/upgrade.mjs");
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
  assert.ok(resolvedTagsMatch(stale, "v1.10.0").length > 0, "stale orchestrator image must fail closed");
  assert.ok(resolvedTagsMatch("", "v1.10.0").length > 0, "missing images must fail closed");
  // Deployed-version metadata is written ONLY by the success path helper,
  // and it records BOTH the release version and the immutable source
  // revision — an image tag alone is never the deployed identity.
  const before = "# deploy comment\nTENVYR_VERSION=v1.2.0\nPOSTGRES_PASSWORD=ref\n";
  const after = applyDeployedMetadata(before, "v1.10.0", "a".repeat(40));
  assert.match(after, /TENVYR_VERSION=v1\.10\.0/);
  assert.ok(!after.includes("TENVYR_VERSION=v1.2.0"), "old deployed version must be replaced");
  assert.match(after, /TENVYR_SOURCE_REVISION=a{40}/);
  assert.match(after, /POSTGRES_PASSWORD=ref/);
  assert.match(after, /# deploy comment/);
  const added = applyDeployedMetadata("# no version yet\n", "v0.4.0", "b".repeat(40));
  assert.ok(added.includes("TENVYR_VERSION=v0.4.0"));
  assert.ok(added.includes(`TENVYR_SOURCE_REVISION=${"b".repeat(40)}`));
});

test("upgrade PROVES the checkout is the exact clean release commit before anything is built", async () => {
  const { proveSourceIdentity } = await awaitImport("../self-hosted/upgrade.mjs");
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
  assert.deepEqual(calls[0], ["rev-parse", "--verify", "--quiet", "v1.10.0^{commit}"]);
});

test("upgrade refuses a target with NO release tag (fails closed; tag is the prerequisite)", async () => {
  const { proveSourceIdentity } = await awaitImport("../self-hosted/upgrade.mjs");
  const noTag = proveSourceIdentity("v9.9.9", () => ({ status: 1, stdout: "" }));
  assert.equal(noTag.ok, false);
  assert.match(noTag.reason, /no release tag "v9\.9\.9" exists/);
});

test("upgrade refuses a checkout that is not the approved release commit (old source under a newer tag)", async () => {
  const { proveSourceIdentity } = await awaitImport("../self-hosted/upgrade.mjs");
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
  assert.match(mismatch.reason, /refusing to build old source under a newer target tag/);
});

test("upgrade refuses a dirty working tree", async () => {
  const { proveSourceIdentity } = await awaitImport("../self-hosted/upgrade.mjs");
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
      return { status: 0, stdout: " M services/orchestrator/src/app.controller.ts\n" };
    }
    return { status: 0, stdout: "" };
  };
  const dirty = proveSourceIdentity("v1.10.0", fakeGit);
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /working tree is not clean/);
});

test("upgrade verifies the RUNNING containers' baked source revision — image tag alone is insufficient proof", async () => {
  const { runningSourceMatches, expectedImageTags } = await awaitImport("../self-hosted/upgrade.mjs");
  const revision = "c".repeat(40);
  assert.equal(runningSourceMatches(`[NODE_ENV=production TENVYR_SOURCE_REVISION=${revision}]`, revision), true);
  assert.equal(runningSourceMatches(`[NODE_ENV=production]`, revision), false);
  assert.equal(runningSourceMatches(`[TENVYR_SOURCE_REVISION=${"d".repeat(40)}]`, revision), false);
  // The Dockerfiles bake the build arg into the production image.
  const orchestratorDockerfile = readFileSync(join(ROOT, "services", "orchestrator", "Dockerfile"), "utf8");
  const gatewayDockerfile = readFileSync(join(ROOT, "services", "gateway", "Dockerfile"), "utf8");
  for (const dockerfile of [orchestratorDockerfile, gatewayDockerfile]) {
    assert.match(dockerfile, /ARG TENVYR_SOURCE_REVISION/);
    assert.match(dockerfile, /ENV TENVYR_SOURCE_REVISION=\$\{TENVYR_SOURCE_REVISION\}/);
  }
  // The upgrade flow: tag identity is checked in the compose resolution
  // AND the baked source revision is verified on the running containers;
  // the persisted metadata records the immutable source revision too.
  const upgrade = readFileSync(join(ROOT, "scripts", "self-hosted", "upgrade.mjs"), "utf8");
  assert.match(upgrade, /image tag alone is never/);
  assert.match(upgrade, /expectedImageTags\(target\)/);
  assert.match(upgrade, /runningSourceMatches/);
  assert.match(upgrade, /TENVYR_SOURCE_REVISION=\$\{sourceRevision\}/);
});

test("upgrade proves source identity BEFORE any stack mutation (source check precedes build/up)", async () => {
  const upgrade = readFileSync(join(ROOT, "scripts", "self-hosted", "upgrade.mjs"), "utf8");
  const proveIndex = upgrade.indexOf("proveSourceIdentity(target)");
  const buildIndex = upgrade.indexOf('"build"');
  const upIndex = upgrade.indexOf('"up", "-d"');
  assert.ok(proveIndex >= 0, "proveSourceIdentity call missing");
  assert.ok(buildIndex >= 0 && upIndex >= 0, "build/up commands missing");
  assert.ok(proveIndex < buildIndex, "source identity must be proven before build");
  assert.ok(proveIndex < upIndex, "source identity must be proven before up");
});

test("restore explicitly separates drill from recovery/promotion", async () => {
  const restore = readFileSync(join(ROOT, "scripts", "self-hosted", "restore.mjs"), "utf8");
  assert.match(restore, /--drill/);
  assert.match(restore, /--promote/);
  assert.match(restore, /DRILL mode: the ACTIVE authority is never touched/);
  assert.match(restore, /PROMOTE mode: this REPLACES the active authority after verification/);
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
  const backup = readFileSync(join(ROOT, "scripts", "self-hosted", "backup.mjs"), "utf8");
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
  const backup = readFileSync(join(ROOT, "scripts", "self-hosted", "backup.mjs"), "utf8");
  const { VERIFY_DB, REQUIRED_ANCHOR_KEYS } = await awaitImport("../self-hosted/backup.mjs");
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
  const anchorsIndex = backup.indexOf("snapshotAnchors(psqlFor(VERIFY_DB), VERIFY_DB)");
  assert.ok(anchorsIndex >= 0 && anchorsIndex < finalizeIndex, "anchors must be computed before finalizing");
  // A failed verification removes the staging artifact and never prints PASS.
  assert.match(backup, /rmSync\(stagingPath/);
  assert.match(backup, /never labeled/);
  assert.match(backup, /reports PASS/);
  // The old live-DB-anchors-before-dump flow is gone.
  assert.ok(!backup.includes("captured immediately before"), "live-DB anchor capture must be gone");
});

test("snapshot anchors are deterministic and manifest-relative comparison fails closed on tamper", async () => {
  const { fingerprint, snapshotAnchors, compareAnchors, TABLES } = await awaitImport("../self-hosted/anchors.mjs");
  assert.equal(fingerprint("same"), fingerprint("same"));
  assert.ok(fingerprint("same") !== fingerprint("different"));
  // Fake runner over a canned database: one line per query result.
  const run = (sql) => {
    if (sql.includes("string_agg(name")) return { status: 0, stdout: "m1|m2\n" };
    if (sql.includes("count(*) FROM")) {
      // One count per inventory table, in order.
      return { status: 0, stdout: `${TABLES.map((_, i) => i + 1).join("|")}\n` };
    }
    if (sql.includes('string_agg("planHash"')) return { status: 0, stdout: "h1|h2\n" };
    if (sql.includes('ORDER BY "createdAt"')) return { status: 0, stdout: "exec-1\n" };
    if (sql.includes('ORDER BY "updatedAt"')) return { status: 0, stdout: "exec-9\n" };
    if (sql.includes("execution_exports")) return { status: 0, stdout: "exp-1:abc|exp-2:def\n" };
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
  assert.match(compareAnchors({ version: "v0.0.1" }, anchors)[0], /predates snapshot anchors/);
});

test("restore verifies the RESTORED snapshot against the BACKUP MANIFEST — the current active database is not the authority", async () => {
  const raw = readFileSync(join(ROOT, "scripts", "self-hosted", "restore.mjs"), "utf8");
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
  assert.ok(!restore.includes("row count mismatch for"), "active-vs-restored row counts must not be a restore requirement");
  assert.ok(!restore.includes("activeHashes"), "active-vs-restored plan hashes must not be a restore requirement");
  assert.ok(!restore.includes("activeExecution"), "active-vs-restored execution identity must not be a restore requirement");
});

test("the disposable recovery E2E is wired and refuses real infrastructure", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts["self-hosted:recovery-test"], /scripts\/self-hosted\/recovery\.test\.mjs/);
  const recovery = readFileSync(join(ROOT, "scripts", "self-hosted", "recovery.test.mjs"), "utf8");
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
  for (const file of readdirSync(entitiesDir).filter((name) => name.endsWith(".entity.ts"))) {
    const source = readFileSync(join(entitiesDir, file), "utf8");
    const match = source.match(/@Entity\("([a-z_]+)"\)/);
    assert.ok(match, `entity ${file} must declare a table name`);
    entityTables.push(match[1]);
  }
  // Authoritative source 2: the migration CREATE TABLE inventory (spec
  // files in the migrations directory are fixtures, not schema).
  const migrationsDir = join(ROOT, "services", "orchestrator", "src", "database", "migrations");
  const migrationTables = new Set();
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))) {
    const source = readFileSync(join(migrationsDir, file), "utf8");
    for (const match of source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/g)) {
      migrationTables.add(match[1]);
    }
  }
  const entitySet = new Set(entityTables);
  assert.equal(entitySet.size, entityTables.length, "duplicate entity table names");
  const backupSet = new Set(TABLES);
  // The backup inventory must equal the entity inventory exactly — a
  // future application authority table cannot silently be omitted.
  const missingFromBackup = [...entitySet].filter((table) => !backupSet.has(table));
  assert.deepEqual(missingFromBackup, [], "entity tables missing from the backup inventory");
  const extraInBackup = [...backupSet].filter((table) => !entitySet.has(table));
  assert.deepEqual(extraInBackup, [], "backup inventory entries with no entity");
  // The migration schema must contain exactly the same Tenvyr-owned tables
  // (the `migrations` framework table is created by TypeORM at runtime,
  // never in the migration files, and is not Tenvyr-owned coverage).
  const migrationEntityOnly = [...migrationTables].filter((table) => !entitySet.has(table));
  assert.deepEqual(migrationEntityOnly, [], "unexpected non-entity schema tables");
  // Spot-check the two tables this closure added.
  assert.ok(backupSet.has("pipelines"));
  assert.ok(backupSet.has("plan_proposals"));
  assert.equal(TABLES.length, 31);
});

test("restore verifies BEFORE quiescing and swaps via a rollback-capable state machine", async () => {
  const restore = readFileSync(join(ROOT, "scripts", "self-hosted", "restore.mjs"), "utf8");
  // Deep manifest-relative verification is a pre-quiesce step in promote
  // (the quiesce() FUNCTION DEFINITION appears earlier in the file, so the
  // assertion anchors on the promote call site).
  const deepIndex = restore.indexOf("deepIntegrityChecks(manifest)");
  const quiesceIndex = restore.indexOf("// 3. Quiesce writers");
  assert.ok(deepIndex >= 0 && quiesceIndex >= 0);
  assert.ok(deepIndex < quiesceIndex, "deep verification must run BEFORE quiescing");
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
  assert.ok(malformedIndex < quiesceIndex, "manifest corruption must fail before quiescing");
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
  const { rollbackPostPromotion } = await awaitImport("../self-hosted/restore.mjs");
  const okSteps = {
    renameActiveToFailed: () => ({ ok: true }),
    renameSafetyToActive: () => ({ ok: true }),
  };
  assert.deepEqual(rollbackPostPromotion(okSteps), { ok: true, phase: "rolled-back" });
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
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
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
    assert.notEqual(result.status, 0, "upgrade must fail when the verified backup fails");
    assert.match(output, /verified backup did not complete/);
    assert.ok(!output.includes("[upgrade] building"), "compose build must never be reached");
    assert.ok(!output.includes("resolving compose"), "compose resolution must never be reached");
    assert.ok(!output.includes("upgrade] OK"), "no success output after backup failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hosted CI wires real PostgreSQL twice, the self-hosted contract gate, and the recovery E2E", async () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "release-ci.yml"), "utf8");
  // Real PostgreSQL job on disposable infrastructure: env set + suite TWICE.
  assert.match(ci, /postgres-integration:/);
  assert.match(ci, /TEST_DATABASE_URL: postgres:\/\/postgres:postgres@localhost:5432\/tenvyr_roadmap_test/);
  const suiteRuns = ci.match(/pnpm --filter orchestrator test -- --runInBand/g);
  assert.ok(suiteRuns && suiteRuns.length >= 2, "the real PostgreSQL suite must run TWICE");
  // The no-silent-skip guard is wired and exists.
  assert.match(ci, /assert-jest-run/);
  assert.ok(existsSync(join(ROOT, "scripts", "assert-jest-run.mjs")), "assert-jest-run.mjs must exist");
  // Self-hosted contract + recovery E2E jobs are required (no opt-outs).
  assert.match(ci, /self-hosted:contract-test/);
  assert.match(ci, /self-hosted:recovery-test/);
  assert.ok(!ci.includes("continue-on-error"), "required closure tests must not continue-on-error");
  // Live provider/CLI gates stay opt-in in hosted CI.
  assert.match(ci, /TENVYR_LIVE_RUNTIME_GATES: "0"/);
});

test("invariants checks are executable: environment contract and pinned images", async () => {
  const { checkEnvironmentContract, checkPinnedImages } = await awaitImport("../self-hosted/invariants.mjs");
  assert.deepEqual(checkEnvironmentContract(COMPOSE), []);
  assert.deepEqual(checkPinnedImages(COMPOSE), []);
  // A floating tag is always flagged.
  assert.deepEqual(checkPinnedImages("  image: tenvyr-orchestrator:latest\n"), [
    'image "tenvyr-orchestrator:latest" is not pinned to a version',
  ]);
  // A legacy DATABASE_URL in the orchestrator block is always flagged.
  assert.ok(
    checkEnvironmentContract("  orchestrator:\n    environment:\n      DATABASE_URL: postgres://x\n      ORCHESTRATOR_PORT: \"3001\"\n  gateway:\n").length > 0,
  );
});

test("package.json wires the advertised upgrade and invariants commands", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts["self-hosted:upgrade"], /scripts\/self-hosted\/upgrade\.mjs/);
  assert.match(pkg.scripts["self-hosted:invariants"], /scripts\/self-hosted\/invariants\.mjs/);
});

const { existsSync } = await import("node:fs");
const awaitImport = (relative) => import(join(dirname(fileURLToPath(import.meta.url)), relative));
