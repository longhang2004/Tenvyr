import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 7A: immutable export manifests and controlled replays.
 *
 * `execution_exports` — a SMALL immutable manifest pinning one execution
 * to one capsule content hash (never duplicated execution truth).
 * `execution_replays` — idempotent replay requests linking the source
 * capsule to a NEW target execution; authority is re-evaluated by the
 * normal claim machinery (historical approvals are never copied).
 */
export class MilestoneSevenCapsuleExports1722270012000
  implements MigrationInterface
{
  name = "MilestoneSevenCapsuleExports1722270012000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "execution_exports" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "capsuleHash" char(64) NOT NULL,
        "exporter" varchar(50) NOT NULL DEFAULT 'operator',
        "note" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_execution_export_capsule"
          UNIQUE ("executionId", "capsuleHash")
      );
      CREATE INDEX IF NOT EXISTS "IDX_execution_export_created"
        ON "execution_exports" ("createdAt", "id");
      CREATE TABLE IF NOT EXISTS "execution_replays" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "sourceExecutionId" uuid NOT NULL,
        "sourceCapsuleHash" char(64) NOT NULL,
        "targetExecutionId" uuid NOT NULL,
        "requester" varchar(50) NOT NULL DEFAULT 'operator',
        "note" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_execution_replay_source"
          UNIQUE ("sourceExecutionId", "sourceCapsuleHash")
      );
      CREATE INDEX IF NOT EXISTS "IDX_execution_replay_target"
        ON "execution_replays" ("targetExecutionId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "execution_replays"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "execution_exports"`);
  }
}
