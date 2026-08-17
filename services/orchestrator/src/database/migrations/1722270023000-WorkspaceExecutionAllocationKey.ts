import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PP1: Workspace Execution Allocation Key & Crash Recovery.
 *
 * Adds allocationKey to workspace_executions to link external allocation
 * idempotency with command idempotency keys and prevent duplicate worktrees.
 */
export class WorkspaceExecutionAllocationKey1722270023000
  implements MigrationInterface
{
  name = "WorkspaceExecutionAllocationKey1722270023000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "workspace_executions"
        ADD COLUMN IF NOT EXISTS "allocationKey" varchar(255);
      CREATE INDEX IF NOT EXISTS "IDX_workspace_execution_allocation_key"
        ON "workspace_executions" ("allocationKey");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_workspace_execution_allocation_key";
      ALTER TABLE "workspace_executions"
        DROP COLUMN IF EXISTS "allocationKey";
    `);
  }
}
