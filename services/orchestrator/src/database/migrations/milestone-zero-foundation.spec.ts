import { MilestoneZeroFoundation1722270000000 } from "./1722270000000-MilestoneZeroFoundation";

describe("MilestoneZeroFoundation migration", () => {
  it("creates and backfills immutable plan and attempt storage", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneZeroFoundation1722270000000().up(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "execution_plan_revisions"',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "step_attempts"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "dispatch_outbox"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "result_inbox"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "result_conflicts"');
    expect(sql).toContain('"source", "reason", "validationResult"');
    expect(sql).toContain("'planHash', 'unavailable'");
    expect(sql).toContain(
      "SELECT e.\"id\", 1, jsonb_build_object('schemaVersion', 1, 'steps', p.\"steps\"),",
    );
    expect(sql).toContain('FROM "step_executions" s');
    // Legacy backfill never fabricates attempts: only rows with persisted
    // attempt evidence map, and only into valid StepAttempt statuses.
    expect(sql).toContain(
      'AND s."status" IN (\'COMPLETED\', \'FAILED\', \'CANCELLED\', \'RUNNING\')',
    );
    expect(sql).toContain("WHEN 'COMPLETED' THEN 'SUCCESS'");
    expect(sql).not.toContain("WHEN 'PENDING' THEN 'CREATED'");
    expect(sql).not.toContain("ELSE s.\"status\"");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_step_attempt_active"',
    );
  });

  it("reverts only additive milestone-zero storage and columns", async () => {
    const queries: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return [{ hasAuthoritativeAttempts: false }];
      }),
    };
    await new MilestoneZeroFoundation1722270000000().down(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('DROP TABLE IF EXISTS "step_attempts"');
    expect(sql).toContain('DROP TABLE IF EXISTS "dispatch_outbox"');
    expect(sql).toContain('DROP TABLE IF EXISTS "result_inbox"');
    expect(sql).toContain('DROP TABLE IF EXISTS "result_conflicts"');
    expect(sql).toContain('DROP TABLE IF EXISTS "execution_plan_revisions"');
    expect(sql).not.toContain('DROP TABLE IF EXISTS "executions"');
    expect(sql).not.toContain('DROP TABLE IF EXISTS "pipelines"');
  });

  it("refuses destructive rollback after runtime attempts exist", async () => {
    const queries: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return [{ hasAuthoritativeAttempts: true }];
      }),
    };

    await expect(
      new MilestoneZeroFoundation1722270000000().down(runner as any),
    ).rejects.toThrow(/forward fix/);
    expect(queries.join("\n")).not.toContain(
      'DROP TABLE IF EXISTS "step_attempts"',
    );
  });
});
