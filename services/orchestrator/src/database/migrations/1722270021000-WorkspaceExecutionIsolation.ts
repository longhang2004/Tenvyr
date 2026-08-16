import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PP1: Workspace Execution / Isolation V1.
 *
 * `workspace_executions` — Tenvyr's authoritative execution workspace lease
 * for a Team Run: source workspace identity, isolation mode (shared |
 * git-worktree), the concrete execution path, frozen base identity, the
 * exclusive owner run, and a durable recoverable lifecycle
 * (ALLOCATING → READY → IN_USE → PRESERVED → REMOVED, + FAILED). The
 * ALLOCATING row commits BEFORE any external `git worktree` mutation;
 * READY is only written after the worktree demonstrably exists;
 * UNIQUE(ownerRunId) forbids concurrent ownership of one lease.
 *
 * Durable truth → included in backup/recovery (M11 inventory).
 */
export class WorkspaceExecutionIsolation1722270021000 implements MigrationInterface {
  name = "WorkspaceExecutionIsolation1722270021000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workspace_executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "sourceWorkspaceId" varchar(255) NOT NULL,
        "sourcePath" varchar(4096) NOT NULL,
        "mode" varchar(32) NOT NULL,
        "executionPath" varchar(4096),
        "baseBranch" varchar(255),
        "baseHeadSha" char(40),
        "ownerRunId" uuid,
        "state" varchar(32) NOT NULL DEFAULT 'ALLOCATING',
        "failureCode" varchar(64),
        "hasUncommittedWork" boolean,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_workspace_execution_owner_run" UNIQUE ("ownerRunId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_workspace_execution_state"
        ON "workspace_executions" ("state");
      CREATE INDEX IF NOT EXISTS "IDX_workspace_execution_source"
        ON "workspace_executions" ("sourceWorkspaceId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "workspace_executions"`);
  }
}