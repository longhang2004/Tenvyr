import { databaseOptions } from "../database.provider";
import { MilestoneEightConnections1722270014000 } from "./1722270014000-MilestoneEightConnections";
import { RoadmapLineageIntegrity1722270013000 } from "./1722270013000-RoadmapLineageIntegrity";

describe("MilestoneEightConnections migration", () => {
  it("creates durable connections and immutable revisions without touching data", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneEightConnections1722270014000().up(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "runtime_connections"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "connection_revisions"');
    // Revisions are immutable durably: a trigger blocks UPDATE/DELETE.
    expect(sql).toContain(
      'CREATE TRIGGER "TRG_connection_revision_immutable"',
    );
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON "connection_revisions"',
    );
    // One canonical revision per (connectionId, revisionNumber).
    expect(sql).toContain(
      'CONSTRAINT "UQ_connection_revision_number"',
    );
    expect(sql).toContain(
      'UNIQUE ("connectionId", "revisionNumber")',
    );
    // Revisions belong to one connection identity.
    expect(sql).toContain(
      'CONSTRAINT "FK_connection_revision_connection"',
    );
    expect(sql).toContain('FOREIGN KEY ("connectionId")');
    expect(sql).toContain('REFERENCES "runtime_connections"("connectionId")');
    // Secret-free profile and conservative capabilities are jsonb evidence.
    expect(sql).toContain('"profile" jsonb NOT NULL');
    expect(sql).toContain('"capabilities" jsonb NOT NULL');
    // Repeat-safe per repository conventions (IF NOT EXISTS everywhere).
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    // No historical backfill: the table DDL portion has no DML at all (the
    // only UPDATE/DELETE words belong to the immutability trigger).
    const tableDdl = sql.split("CREATE TRIGGER")[0];
    expect(tableDdl).not.toMatch(
      /\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b|\bSELECT\b/i,
    );
  });

  it("reverts only the connection storage", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneEightConnections1722270014000().down(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('DROP TABLE IF EXISTS "connection_revisions"');
    expect(sql).toContain('DROP TABLE IF EXISTS "runtime_connections"');
    expect(sql).toContain('DROP TRIGGER IF EXISTS "TRG_connection_revision_immutable"');
    expect(sql).not.toContain("executions");
    expect(sql).not.toContain("pipelines");
  });

  it("is ordered after the M7 migration in the production configuration", () => {
    expect(new MilestoneEightConnections1722270014000().name).toContain(
      "1722270014000",
    );
    expect(new RoadmapLineageIntegrity1722270013000().name).toContain(
      "1722270013000",
    );
    const options = databaseOptions();
    const registered = (options.migrations as Array<{ name: string }>).map(
      (migration) => migration.name,
    );
    expect(registered).toContain("MilestoneEightConnections1722270014000");
    expect(
      registered.indexOf("MilestoneEightConnections1722270014000"),
    ).toBe(registered.indexOf("RoadmapLineageIntegrity1722270013000") + 1);
  });
});
