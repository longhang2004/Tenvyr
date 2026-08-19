import type { MigrationInterface, QueryRunner } from "typeorm";

export class WorkspaceReleaseLock1722270026000 implements MigrationInterface {
  name = "WorkspaceReleaseLock1722270026000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workspace_release_locks" (
        "workspaceExecutionId" varchar(36) PRIMARY KEY,
        "releaseOperationId" varchar(36) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      );
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "workspace_release_locks"`);
  }
}
