import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function assertCoordinationDeadline(a, b, timeA, timeB) {
  assert.ok(
    a && Number.isFinite(a.remainingDeadlineMs) && a.remainingDeadlineMs >= 0,
    "original remainingDeadlineMs must be finite and nonnegative",
  );
  assert.ok(
    b && Number.isFinite(b.remainingDeadlineMs) && b.remainingDeadlineMs >= 0,
    "candidate remainingDeadlineMs must be finite and nonnegative",
  );
  assert.ok(
    Number.isFinite(timeA) && Number.isFinite(timeB),
    "observation timestamps must be valid",
  );
  const commonTime = Math.max(timeA, timeB);
  const countdownA = Math.max(0, a.remainingDeadlineMs - (commonTime - timeA));
  const countdownB = Math.max(0, b.remainingDeadlineMs - (commonTime - timeB));
  assert.ok(
    Math.abs(countdownA - countdownB) < 5000,
    `coordination remainingDeadlineMs at common observation time mismatch: original=${countdownA} candidate=${countdownB}`,
  );
}

export function selfCheck() {
  const baseTime = 1_700_000_000_000;
  // Case 1: >5s inter-snapshot startup lag with identical deadline passes
  const timeB1 = baseTime;
  const timeA1 = baseTime + 8_000; // 8s startup lag (> 5s)
  assertCoordinationDeadline(
    { remainingDeadlineMs: 52_000 },
    { remainingDeadlineMs: 60_000 },
    timeA1,
    timeB1,
  );

  // Case 2: Expiry crossing during inter-snapshot lag clamps to 0 and passes
  const timeB2 = baseTime;
  const timeA2 = baseTime + 8_000;
  assertCoordinationDeadline(
    { remainingDeadlineMs: 0 },
    { remainingDeadlineMs: 4_000 },
    timeA2,
    timeB2,
  );

  // Case 3: Genuinely inconsistent deadline fails
  assert.throws(
    () =>
      assertCoordinationDeadline(
        { remainingDeadlineMs: 22_000 },
        { remainingDeadlineMs: 60_000 },
        timeA1,
        timeB1,
      ),
    /mismatch|AssertionError/,
  );

  // Case 4: Negative, non-finite, or missing candidates fail
  assert.throws(
    () =>
      assertCoordinationDeadline(
        { remainingDeadlineMs: -1 },
        { remainingDeadlineMs: 60_000 },
        timeA1,
        timeB1,
      ),
    /AssertionError/,
  );
  assert.throws(
    () =>
      assertCoordinationDeadline(
        { remainingDeadlineMs: 52_000 },
        null,
        timeA1,
        timeB1,
      ),
    /AssertionError/,
  );

  console.log(
    "backend-capsule-oracle self-check PASS: >5s lag, expiry crossing, and inconsistent deadline rejection verified",
  );
}

if (process.argv.includes("--self-check")) {
  selfCheck();
  process.exit(0);
}

const require = createRequire(
  new URL("../services/orchestrator/package.json", import.meta.url),
);
require("reflect-metadata");
const { DataSource } = require("typeorm");
const source = (path) =>
  require(
    fileURLToPath(
      new URL(`../services/orchestrator/dist/${path}.js`, import.meta.url),
    ),
  );
const { databaseOptions } = source("database/database.provider");
const { ExecutionService } = source("services/execution.service");
const { DelegationService } = source("services/delegation.service");
const { ExecutionCapsuleService } = source(
  "services/execution-capsule.service",
);
const { WorkbenchProjectionService } = source(
  "services/workbench-projection.service",
);
const { AttentionService } = source("services/attention.service");
const url = new URL(
  (
    process.env.TEST_DATABASE_URL || process.env.TENVYR_TEST_DATABASE_URL
  ).replace(/^jdbc:/, ""),
);
assert.match(url.pathname, /test|scratch|disposable/);
const schema = process.env.TENVYR_TEST_SCHEMA;
assert.match(schema, /^[a-z][a-z0-9_]+$/);
const ds = new DataSource({
  ...databaseOptions({
    POSTGRES_HOST: url.hostname,
    POSTGRES_PORT: url.port || "5432",
    POSTGRES_DB: url.pathname.slice(1),
    POSTGRES_USER: decodeURIComponent(
      url.username || process.env.POSTGRES_USER || "postgres",
    ),
    POSTGRES_PASSWORD: decodeURIComponent(
      url.password || process.env.POSTGRES_PASSWORD || "postgres",
    ),
  }),
  schema,
  migrationsRun: false,
  synchronize: false,
  logging: false,
  extra: { options: `-c search_path=${schema},public` },
});
await ds.initialize();
try {
  const execution = new ExecutionService(
    ds.getRepository("ExecutionEntity"),
    ds.getRepository("LogicalStepEntity"),
    ds.getRepository("StepAttemptEntity"),
    ds.getRepository("ExecutionPlanRevisionEntity"),
    ds,
  );
  const delegation = new DelegationService(ds, execution);
  const service = new ExecutionCapsuleService(ds, delegation, execution);
  const workbench = new WorkbenchProjectionService(
    ds,
    undefined,
    delegation,
    execution,
  );
  const id = process.env.TENVYR_EXECUTION_ID;
  const original = JSON.parse(
    JSON.stringify({
      capsule: await service.build(id),
      capsuleSummary: await workbench.capsuleFor(id),
      connections: await workbench.connectionCards(),
      executions: await workbench.executionSummaries(),
      projection: await workbench.executionProjection(id),
      attention: await new AttentionService(ds).attention(),
    }),
  );
  const candidate = JSON.parse(
    readFileSync(process.env.TENVYR_JAVA_CAPSULE_PATH, "utf8"),
  );
  const timeA = Date.parse(original.projection?.serverTime);
  const timeB = Date.parse(candidate.projection?.serverTime);
  for (const value of [original, candidate]) {
    for (const [object, field] of [
      [value.capsule, "capturedAt"],
      ...["connections", "executions", "projection", "attention"].map((key) => [
        value[key],
        "serverTime",
      ]),
    ]) {
      assert.equal(typeof object[field], "string");
      assert.ok(Number.isFinite(Date.parse(object[field])));
      object[field] = "<capture time>";
    }
  }
  if (original.projection.coordination) {
    const a = original.projection.coordination.run;
    const b = candidate.projection.coordination?.run;
    assertCoordinationDeadline(a, b, timeA, timeB);
    a.remainingDeadlineMs = b.remainingDeadlineMs = 0;
  }
  assert.deepEqual(
    candidate,
    original,
    "Java capsule/hash and Workbench read models must equal original production services on the same authoritative rows",
  );
  console.log(
    "Original read-model oracle PASS: capsule/hash, connections, summaries, execution projection, Attention",
  );
} finally {
  await ds.destroy();
}
