import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 5A: durable PlanPatch proposals and terminal decisions.
 *
 * `plan_proposals` — one immutable proposal per execution number; the
 * activating transaction decides it ACCEPTED/REJECTED/STALE exactly once.
 * `decisionReason` explains terminal decisions; the proposal payload is
 * hash-pinned for provenance.
 */
export class MilestoneFivePlanProposals1722270009000
  implements MigrationInterface
{
  name = "MilestoneFivePlanProposals1722270009000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plan_proposals" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "proposalNumber" int NOT NULL,
        "baseRevision" int NOT NULL,
        "proposal" jsonb NOT NULL,
        "proposalHash" char(64) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "decisionReason" text,
        "source" varchar(50) NOT NULL DEFAULT 'operator',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "decidedAt" timestamp,
        CONSTRAINT "UQ_plan_proposal_number"
          UNIQUE ("executionId", "proposalNumber"),
        CONSTRAINT "CHK_plan_proposal_status"
          CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'STALE'))
      );
      CREATE INDEX IF NOT EXISTS "IDX_plan_proposal_execution_status"
        ON "plan_proposals" ("executionId", "status");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "plan_proposals"`);
  }
}
