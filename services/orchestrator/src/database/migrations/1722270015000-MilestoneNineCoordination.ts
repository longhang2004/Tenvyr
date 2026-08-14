import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 9A: minimal durable Coordinator authority.
 *
 * `coordination_runs` — one-to-one authority extension of an Execution:
 * frozen team configuration + hard limits, phase, current iteration number,
 * cumulative worker count, loop deadline, active iteration, version. It is
 * NOT a second Execution or user-facing workflow resource.
 *
 * `coordination_iterations` — stable iteration identity with unique
 * (run, number); frozen Planner proposal; accepted plan revision; bounded
 * worker manifest referencing LogicalStep IDs (required/optional); Verifier
 * step/attempt; immutable consumed decision + canonical hash; terminal
 * iteration outcome. Worker work itself is never duplicated here.
 *
 * One-winner decision consumption is enforced at the application level
 * (run-row lock + guarded `decisionHash IS NULL` update) and backstopped
 * by the unique consumed verifier attempt per run.
 */
export class MilestoneNineCoordination1722270015000
  implements MigrationInterface
{
  name = "MilestoneNineCoordination1722270015000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "coordination_runs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "config" jsonb NOT NULL,
        "phase" varchar(50) NOT NULL DEFAULT 'PLANNING',
        "currentIterationNumber" integer NOT NULL DEFAULT 0,
        "cumulativeWorkers" integer NOT NULL DEFAULT 0,
        "loopDeadlineAt" timestamp NOT NULL,
        "activeIterationId" uuid,
        "waitReason" text,
        "version" integer NOT NULL DEFAULT 1,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_coordination_run_execution" UNIQUE ("executionId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_coordination_run_phase"
        ON "coordination_runs" ("phase");
      CREATE TABLE IF NOT EXISTS "coordination_iterations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "coordinationRunId" uuid NOT NULL,
        "iterationNumber" integer NOT NULL,
        "plannerAttemptId" uuid,
        "plannerProposal" jsonb,
        "plannerStepId" varchar(100),
        "acceptedPlanRevisionId" uuid,
        "workerManifest" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "verifierStepId" varchar(100),
        "verifierAttemptId" uuid,
        "decision" jsonb,
        "decisionHash" varchar(64),
        "outcome" varchar(50),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_coordination_iteration_number"
          UNIQUE ("coordinationRunId", "iterationNumber"),
        CONSTRAINT "FK_coordination_iteration_run"
          FOREIGN KEY ("coordinationRunId")
          REFERENCES "coordination_runs"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_coordination_iteration_run_number"
        ON "coordination_iterations" ("coordinationRunId", "iterationNumber");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_coordination_iteration_verifier"
        ON "coordination_iterations" ("coordinationRunId", "verifierAttemptId")
        WHERE "verifierAttemptId" IS NOT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_coordination_iteration_verifier";
      DROP TABLE IF EXISTS "coordination_iterations";
      DROP TABLE IF EXISTS "coordination_runs";
    `);
  }
}
