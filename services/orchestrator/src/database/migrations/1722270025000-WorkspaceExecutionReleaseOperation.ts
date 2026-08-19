import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PP1 FINAL CLOSURE: Safe Release — exact operation correlation.
 *
 * Every RELEASE_REQUESTED that may trigger recovery-time Git mutation must be
 * correlated with the EXACT durable release operation that authorized it.
 * Adds releaseOperationId (OperatorAction id) to workspace_executions.
 * Legacy/unmatched RELEASE_REQUESTED fails closed (RELEASE_UNAUTHORIZED).
 */
export class WorkspaceExecutionReleaseOperation1722270025000
  implements MigrationInterface
{
  name = "WorkspaceExecutionReleaseOperation1722270025000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "workspace_executions"
        ADD COLUMN IF NOT EXISTS "releaseOperationId" varchar(36);
      CREATE INDEX IF NOT EXISTS "IDX_workspace_execution_release_op"
        ON "workspace_executions" ("releaseOperationId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_workspace_execution_release_op";
      ALTER TABLE "workspace_executions"
        DROP COLUMN IF EXISTS "releaseOperationId";
    `);
  }
}
