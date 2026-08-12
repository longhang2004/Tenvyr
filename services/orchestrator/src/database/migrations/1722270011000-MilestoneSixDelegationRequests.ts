import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 6B: authoritative supervised delegation requests.
 *
 * `delegation_requests` — one PENDING/APPROVED/REJECTED/EXPIRED request
 * per parent attempt (idempotent per (parentAttemptId, requestId)).
 * Approval materializes the child Execution and links childExecutionId
 * in the SAME transaction (all-or-none). The parent-attempt FK cascades.
 */
export class MilestoneSixDelegationRequests1722270011000
  implements MigrationInterface
{
  name = "MilestoneSixDelegationRequests1722270011000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "delegation_requests" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "parentExecutionId" uuid NOT NULL,
        "parentAttemptId" uuid NOT NULL,
        "requestId" varchar(255) NOT NULL,
        "requestedAgent" varchar(255) NOT NULL,
        "childDepth" int NOT NULL DEFAULT 1,
        "childExecutionId" uuid,
        "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "decisionNote" text,
        "expiresAt" timestamp NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "decidedAt" timestamp,
        CONSTRAINT "UQ_delegation_request_identity"
          UNIQUE ("parentAttemptId", "requestId"),
        CONSTRAINT "FK_delegation_request_parent_attempt"
          FOREIGN KEY ("parentAttemptId") REFERENCES "step_attempts" ("id")
          ON DELETE CASCADE,
        CONSTRAINT "CHK_delegation_request_status"
          CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'))
      );
      CREATE INDEX IF NOT EXISTS "IDX_delegation_request_status_expiry"
        ON "delegation_requests" ("status", "expiresAt");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "delegation_requests"`);
  }
}
