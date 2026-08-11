import { databaseOptions } from "../database.provider";
import { MilestoneTwoArtifactIdentity1722270002000 } from "./1722270002000-MilestoneTwoArtifactIdentity";
import { MilestoneTwoExecutionState1722270003000 } from "./1722270003000-MilestoneTwoExecutionState";

describe("MilestoneTwoExecutionState migration", () => {
  it("adds the three execution state columns with defaults and no DML", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneTwoExecutionState1722270003000().up(runner as any);
    const sql = queries.join("\n");

    // One ALTER per column, all repeat-safe, mirroring the entity metadata
    // so synchronize-based disposable schemas match the migrated schema.
    expect(sql).toContain(
      'ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "executionState" jsonb NOT NULL DEFAULT',
    );
    expect(sql).toContain(
      'ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "executionStateVersion" integer NOT NULL DEFAULT 0',
    );
    expect(sql).toContain(
      'ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "executionStateUpdatedAt" timestamp',
    );
    expect(queries).toHaveLength(3);
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(3);
    // No unrelated backfill: column defaults give existing rows
    // `{}` at semantic version 0; the migration performs no DML at all.
    expect(sql).not.toMatch(
      /\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b|\bSELECT\b|\bCREATE TABLE\b/i,
    );
  });

  it("reverts only the execution state columns", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneTwoExecutionState1722270003000().down(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('DROP COLUMN IF EXISTS "executionState"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "executionStateVersion"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "executionStateUpdatedAt"');
    expect(queries).toHaveLength(3);
    expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    expect(sql).not.toContain("artifacts");
  });

  it("is ordered immediately after the Milestone 2A migration in the production configuration", () => {
    expect(new MilestoneTwoExecutionState1722270003000().name).toContain(
      "1722270003000",
    );
    const registered = (
      databaseOptions().migrations as Array<{ name: string }>
    ).map((migration) => migration.name);
    expect(registered).toContain("MilestoneTwoExecutionState1722270003000");
    expect(registered.indexOf("MilestoneTwoExecutionState1722270003000")).toBe(
      registered.indexOf("MilestoneTwoArtifactIdentity1722270002000") + 1,
    );
  });
});
