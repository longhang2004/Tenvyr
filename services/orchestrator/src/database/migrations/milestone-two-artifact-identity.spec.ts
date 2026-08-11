import { databaseOptions } from "../database.provider";
import { MilestoneOneAgentEvents1722270001000 } from "./1722270001000-MilestoneOneAgentEvents";
import { MilestoneTwoArtifactIdentity1722270002000 } from "./1722270002000-MilestoneTwoArtifactIdentity";

describe("MilestoneTwoArtifactIdentity migration", () => {
  it("creates the immutable artifact identity index without touching data", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneTwoArtifactIdentity1722270002000().up(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "artifacts"');
    expect(sql).toContain('"resultInboxId" uuid NOT NULL');
    expect(sql).toContain('"descriptorOrdinal" integer NOT NULL');
    expect(sql).toContain('"descriptorHash" varchar(64) NOT NULL');
    // One canonical ResultInbox descriptor registers at most once.
    expect(sql).toContain(
      'CONSTRAINT "UQ_artifact_inbox_ordinal" UNIQUE ("resultInboxId", "descriptorOrdinal")',
    );
    // Lineage is explicit; deletion mirrors agent_events -> step_attempts.
    expect(sql).toContain(
      'CONSTRAINT "FK_artifact_inbox" FOREIGN KEY ("resultInboxId")',
    );
    expect(sql).toContain('REFERENCES "result_inbox"("id") ON DELETE CASCADE');
    // Repeat-safe per repository conventions (IF NOT EXISTS everywhere).
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(1);
    // No historical backfill: a single CREATE TABLE statement, no DML at all.
    expect(queries).toHaveLength(1);
    expect(sql).not.toMatch(
      /\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b|\bSELECT\b/i,
    );
  });

  it("reverts only the artifact identity storage", async () => {
    const queries: string[] = [];
    const runner = { query: jest.fn(async (sql: string) => queries.push(sql)) };
    await new MilestoneTwoArtifactIdentity1722270002000().down(runner as any);
    const sql = queries.join("\n");

    expect(sql).toContain('DROP TABLE IF EXISTS "artifacts"');
    expect(sql).not.toContain("result_inbox");
    expect(sql).not.toContain("step_attempts");
  });

  it("is ordered after the Milestone 1 migration in the production configuration", () => {
    expect(new MilestoneTwoArtifactIdentity1722270002000().name).toContain(
      "1722270002000",
    );
    expect(new MilestoneOneAgentEvents1722270001000().name).toContain(
      "1722270001000",
    );
    const options = databaseOptions();
    const registered = (options.migrations as Array<{ name: string }>).map(
      (migration) => migration.name,
    );
    expect(registered).toContain("MilestoneTwoArtifactIdentity1722270002000");
    expect(
      registered.indexOf("MilestoneTwoArtifactIdentity1722270002000"),
    ).toBe(registered.indexOf("MilestoneOneAgentEvents1722270001000") + 1);
  });
});
