import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 4C: durable approvals and WAITING.
 *
 * `approval_requests` — one PENDING/APPROVED/DENIED/EXPIRED request per
 * intercepted action (proposalId unique). Approving resumes the SAME
 * attempt (same invocationId); replay can never re-execute or mint a second
 * outbox row. Expiry is deterministic; the recovery sweep terminalizes due
 * requests.
 */
export class MilestoneFourApprovals1722270008000 implements MigrationInterface {
  name = "MilestoneFourApprovals1722270008000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "approval_requests" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "proposalId" varchar(64) NOT NULL,
        "proposalHash" char(64) NOT NULL,
        "actionType" varchar(32) NOT NULL,
        "executionId" varchar(255) NOT NULL,
        "logicalStepId" varchar(255) NOT NULL,
        "attemptNumber" int NOT NULL,
        "targetAgent" varchar(255),
        "targetExecutor" varchar(255),
        "status" varchar(16) NOT NULL,
        "expiresAt" timestamp NOT NULL,
        "decidedAt" timestamp,
        "decisionNote" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_approval_request_proposal" UNIQUE ("proposalId"),
        CONSTRAINT "CHK_approval_request_status"
          CHECK ("status" IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED'))
      );
      CREATE INDEX IF NOT EXISTS "IDX_approval_request_status_expiry"
        ON "approval_requests" ("status", "expiresAt");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "approval_requests"`);
  }
}
