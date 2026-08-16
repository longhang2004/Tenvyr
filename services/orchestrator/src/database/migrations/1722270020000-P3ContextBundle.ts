import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * P3: Invocation Efficiency / Context Projection baseline.
 *
 * `step_attempts.efficiency` — the IMMUTABLE bounded
 * `InvocationEfficiencyEvidenceV1` record for the attempt's runtime
 * invocation: ContextBundle identity + reuse flag, frozen harness identity,
 * workspace structural identity, context projection metrics, session mode,
 * reported usage, and timing. One jsonb column on the existing attempts
 * table — intentionally NOT a new giant execution table. Written once at
 * claim time and completed once at result acceptance; telemetry carries
 * hashes/sizes/counts/ids only, never raw prompts or credentials.
 */
export class P3ContextBundle1722270020000 implements MigrationInterface {
  name = "P3ContextBundle1722270020000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "step_attempts"
        ADD COLUMN IF NOT EXISTS "efficiency" jsonb
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "step_attempts"
        DROP COLUMN IF EXISTS "efficiency"
    `);
  }
}