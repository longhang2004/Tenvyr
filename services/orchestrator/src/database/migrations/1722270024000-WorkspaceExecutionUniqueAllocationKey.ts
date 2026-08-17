import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PP1: Unique Allocation Key Index on workspace_executions.
 *
 * Enforces atomic concurrency safety for allocateExecutionWorkspace.
 * Prevents race conditions from inserting duplicate ALLOCATING rows for the
 * same allocationKey.
 */
export class WorkspaceExecutionUniqueAllocationKey1722270024000
  implements MigrationInterface
{
  name = "WorkspaceExecutionUniqueAllocationKey1722270024000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_workspace_execution_allocation_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_workspace_execution_allocation_key_unique"
        ON "workspace_executions" ("allocationKey")
        WHERE "allocationKey" IS NOT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_workspace_execution_allocation_key_unique";
      CREATE INDEX IF NOT EXISTS "IDX_workspace_execution_allocation_key"
        ON "workspace_executions" ("allocationKey");
    `);
  }
}
