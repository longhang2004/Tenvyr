import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 2D: append-only attempt-to-artifact exposure lineage.
 *
 * One immutable `artifact_exposures` row per (consumer StepAttempt, projected
 * Artifact) pair, inserted atomically with the claim that froze the
 * ContextSnapshot containing the reference. The row proves Tenvyr exposed the
 * Tenvyr-owned Artifact identity to the attempt; it never claims dispatch
 * success, URI opening, or semantic consumption.
 *
 * No historical backfill: exposure begins with this migration; older attempts
 * get no invented lineage. Foreign keys deliberately use NO ACTION so a
 * referenced Artifact or consumer StepAttempt is never silently cascade-
 * deleted through this relation (authoritative audit truth is preserved).
 * `artifact_exposures` does not duplicate descriptors or snapshot JSON.
 */
export class MilestoneTwoArtifactExposure1722270004000 implements MigrationInterface {
  name = "MilestoneTwoArtifactExposure1722270004000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "artifact_exposures" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stepAttemptId" uuid NOT NULL,
        "artifactId" uuid NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_artifact_exposure_attempt_artifact" UNIQUE ("stepAttemptId", "artifactId"),
        CONSTRAINT "FK_artifact_exposure_attempt" FOREIGN KEY ("stepAttemptId")
          REFERENCES "step_attempts"("id"),
        CONSTRAINT "FK_artifact_exposure_artifact" FOREIGN KEY ("artifactId")
          REFERENCES "artifacts"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_artifact_exposure_artifact" ON "artifact_exposures" ("artifactId")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "artifact_exposures"`);
  }
}
