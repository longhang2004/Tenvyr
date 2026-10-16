import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../services/orchestrator/package.json", import.meta.url),
);
require("reflect-metadata");
const { DataSource } = require("typeorm");
const { Client } = require("pg");
const { databaseOptions } = require(
  fileURLToPath(
    new URL(
      "../services/orchestrator/dist/database/database.provider.js",
      import.meta.url,
    ),
  ),
);
const raw =
  process.env.TEST_DATABASE_URL || process.env.TENVYR_TEST_DATABASE_URL;
assert.ok(raw, "TEST_DATABASE_URL required");
const url = new URL(raw.replace(/^jdbc:/, ""));
assert.match(
  url.pathname,
  /test|scratch|disposable/,
  "disposable database required",
);
const user = decodeURIComponent(
  url.username || process.env.POSTGRES_USER || "postgres",
);
const password = decodeURIComponent(
  url.password || process.env.POSTGRES_PASSWORD || "postgres",
);
const suffix = randomUUID().replaceAll("-", "");
const reference = `node_reference_${suffix}`;
const candidate = `java_candidate_${suffix}`;
const admin = new Client({
  host: url.hostname,
  port: Number(url.port || 5432),
  database: url.pathname.slice(1),
  user,
  password,
});
await admin.connect();
let original;
function javaMigration(operation, schema, count) {
  const result = spawnSync(
    process.env.TENVYR_JAVA_EXECUTABLE || "java",
    [
      "-ea",
      "-cp",
      "backend/platform/target/test-classes:backend/platform/target/classes:backend/platform/target/dependency/*",
      "io.tenvyr.platform.MigrationIntegrationCheck",
      operation,
      schema,
      String(count),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        POSTGRES_USER: user,
        POSTGRES_PASSWORD: password,
        TENVYR_TEST_JDBC_URL: `jdbc:postgresql://${url.host}${url.pathname}`,
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `${operation} ${schema}: ${result.stdout}\n${result.stderr}`,
  );
}
async function snapshot(schema) {
  const queries = [
    [
      "columns",
      "SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position",
    ],
    [
      "constraints",
      "SELECT c.relname AS table_name,t.conname,t.contype,pg_get_constraintdef(t.oid) AS definition FROM pg_constraint t JOIN pg_class c ON c.oid=t.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,t.conname",
    ],
    [
      "indexes",
      "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname",
    ],
  ];
  const out = {};
  for (const [key, sql] of queries)
    out[key] = JSON.parse(
      JSON.stringify((await admin.query(sql, [schema])).rows).replaceAll(
        schema,
        "SCHEMA",
      ),
    );
  return out;
}
try {
  await admin.query(
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
  );
  await admin.query(`CREATE SCHEMA "${reference}"`);
  await admin.query(`CREATE SCHEMA "${candidate}"`);
  original = new DataSource({
    ...databaseOptions({
      POSTGRES_HOST: url.hostname,
      POSTGRES_PORT: url.port || "5432",
      POSTGRES_DB: url.pathname.slice(1),
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
    }),
    schema: reference,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: { options: `-c search_path=${reference},public` },
  });
  await original.initialize();
  assert.equal(
    (await original.runMigrations()).length,
    27,
    "original TypeORM applies all migrations",
  );
  const before = (
    await admin.query(
      `SELECT id,name,timestamp FROM "${reference}".migrations ORDER BY id`,
    )
  ).rows;
  javaMigration("migrate", reference, 0);
  assert.deepEqual(
    (
      await admin.query(
        `SELECT id,name,timestamp FROM "${reference}".migrations ORDER BY id`,
      )
    ).rows,
    before,
    "Java preserves original TypeORM ledger exactly",
  );
  javaMigration("migrate", candidate, 27);
  javaMigration("migrate", candidate, 0);
  assert.deepEqual(
    (
      await admin.query(
        `SELECT id,name,timestamp FROM "${candidate}".migrations ORDER BY id`,
      )
    ).rows,
    before,
    "empty-schema migration identities match",
  );
  assert.deepEqual(
    await snapshot(candidate),
    await snapshot(reference),
    "all physical columns, constraints, and indexes match original TypeORM",
  );
  javaMigration("revert", candidate, 27);
  for (let count = 0; count < 27; count++) await original.undoLastMigration();
  assert.deepEqual(
    await snapshot(candidate),
    await snapshot(reference),
    "all 27 down migrations match",
  );
  console.log(
    "Database compatibility PASS: original TypeORM ledger preserved; 27 up/down migrations; exact columns/constraints/indexes",
  );
} finally {
  if (original?.isInitialized) await original.destroy();
  await admin.query(`DROP SCHEMA IF EXISTS "${reference}" CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS "${candidate}" CASCADE`);
  await admin.end();
}
