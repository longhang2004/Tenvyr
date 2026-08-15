import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Product Phase 1: Workspace identity + run workspace freeze.
 *
 * `workspaces` — stable workspace rows (name, absolute path, last captured
 * repository identity snapshot).
 *
 * `coordination_runs.workspace` — the FROZEN WorkspaceSnapshotV1 a team run
 * executed against (bounded jsonb, nullable for runs without a workspace).
 * `coordination_runs.acceptanceEvidence` — optional operator-declared
 * acceptance evidence (test/build/lint/typecheck commands + required
 * artifact names; run METADATA only — the orchestrator never executes
 * them).
 */
export class WorkspaceIdentity1722270018000 implements MigrationInterface {
  name = "WorkspaceIdentity1722270018000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workspaces" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(255) NOT NULL,
        "path" varchar(4096) NOT NULL,
        "snapshot" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "coordination_runs"
        ADD COLUMN IF NOT EXISTS "workspace" jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE "coordination_runs"
        ADD COLUMN IF NOT EXISTS "acceptanceEvidence" jsonb
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "coordination_runs"
        DROP COLUMN IF EXISTS "acceptanceEvidence"
    `);
    await queryRunner.query(`
      ALTER TABLE "coordination_runs"
        DROP COLUMN IF EXISTS "workspace"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "workspaces"`);
  }
}
