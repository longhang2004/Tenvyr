import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
    assert.ok(
      b && Number.isFinite(b.remainingDeadlineMs) && b.remainingDeadlineMs >= 0,
    );
    assert.ok(Math.abs(a.remainingDeadlineMs - b.remainingDeadlineMs) < 5000);
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
