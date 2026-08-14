import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 9/S7: exact pending PlanPatch proposal identity on the
 * iteration.
 *
 * When a Planner batch activation is intercepted by policy as
 * REQUIRE_APPROVAL, the durable PlanPatch proposal (and its approval
 * request) must be recoverable by identity — approval resumes and binds
 * THAT SAME proposal exactly once, and reconciliation re-activates it
 * instead of proposing a new one (no proposal storms).
 *
 * The column is nullable: set only while a batch activation is awaiting
 * approval; cleared when the same proposal activates.
 */
export class CoordinationApprovalResume1722270017000
  implements MigrationInterface
{
  name = "CoordinationApprovalResume1722270017000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "coordination_iterations"
        ADD COLUMN IF NOT EXISTS "pendingPlanProposalId" uuid;
      CREATE INDEX IF NOT EXISTS "IDX_coordination_iteration_pending_proposal"
        ON "coordination_iterations" ("pendingPlanProposalId")
        WHERE "pendingPlanProposalId" IS NOT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_coordination_iteration_pending_proposal";
      ALTER TABLE "coordination_iterations"
        DROP COLUMN IF EXISTS "pendingPlanProposalId";
    `);
  }
}
