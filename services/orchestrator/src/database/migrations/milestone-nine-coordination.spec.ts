import { databaseOptions } from "../database.provider";
import { MilestoneNineCoordination1722270015000 } from "./1722270015000-MilestoneNineCoordination";
import { MilestoneEightConnections1722270014000 } from "./1722270014000-MilestoneEightConnections";

describe("MilestoneNineCoordination migration", () => {
  it("creates durable run/iteration authority without touching data", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneNineCoordination1722270015000().up(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "coordination_runs"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "coordination_iterations"');
    // One-to-one run per execution; frozen config; guarded version.
    expect(sql).toContain(
      'CONSTRAINT "UQ_coordination_run_execution" UNIQUE ("executionId")',
    );
    expect(sql).toContain('"config" jsonb NOT NULL');
    expect(sql).toContain('"version" integer NOT NULL DEFAULT 1');
    // One canonical iteration per (run, number).
    expect(sql).toContain(
      'CONSTRAINT "UQ_coordination_iteration_number"',
    );
    expect(sql).toContain(
      'UNIQUE ("coordinationRunId", "iterationNumber")',
    );
    // Iterations belong to one run; work is referenced, never duplicated.
    expect(sql).toContain(
      'CONSTRAINT "FK_coordination_iteration_run"',
    );
    expect(sql).toContain('FOREIGN KEY ("coordinationRunId")');
    expect(sql).toContain('REFERENCES "coordination_runs"("id") ON DELETE CASCADE');
    expect(sql).toContain('"workerManifest" jsonb NOT NULL DEFAULT \'[]\'::jsonb');
    // One consumed verifier attempt per run (one-winner backstop).
    expect(sql).toContain(
      '"UQ_coordination_iteration_verifier"',
    );
    expect(sql).toContain('"verifierAttemptId" IS NOT NULL');
    // Repeat-safe per repository conventions (IF NOT EXISTS everywhere).
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    // No historical backfill: no DML at all.
    expect(sql).not.toMatch(
      /\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b|\bSELECT\b/i,
    );
  });

  it("reverts only the coordination storage", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneNineCoordination1722270015000().down(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('DROP TABLE IF EXISTS "coordination_iterations"');
    expect(sql).toContain('DROP TABLE IF EXISTS "coordination_runs"');
    expect(sql).not.toContain("executions");
    expect(sql).not.toContain("connection_revisions");
  });

  it("is ordered after the M8 migration in the production configuration", () => {
    expect(new MilestoneNineCoordination1722270015000().name).toContain(
      "1722270015000",
    );
    expect(new MilestoneEightConnections1722270014000().name).toContain(
      "1722270014000",
    );
    const options = databaseOptions();
    const registered = (options.migrations as Array<{ name: string }>).map(
      (migration) => migration.name,
    );
    expect(registered).toContain("MilestoneNineCoordination1722270015000");
    expect(
      registered.indexOf("MilestoneNineCoordination1722270015000"),
    ).toBe(registered.indexOf("MilestoneEightConnections1722270014000") + 1);
  });
});
