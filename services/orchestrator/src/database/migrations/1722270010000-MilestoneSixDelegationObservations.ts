import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 6A: observed-mode delegation evidence.
 *
 * `delegation_observations` — inert, bounded, hash-pinned evidence of one
 * runtime-asserted child per parent attempt (identity = provider:childId).
 * Observations never schedule, spend, cancel, or terminalize work.
 * `delegation_observation_conflicts` retains hash-mismatched deliveries.
 */
export class MilestoneSixDelegationObservations1722270010000
  implements MigrationInterface
{
  name = "MilestoneSixDelegationObservations1722270010000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "delegation_observations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stepAttemptId" uuid NOT NULL,
        "invocationId" varchar(255) NOT NULL,
        "executionId" uuid NOT NULL,
        "observationId" varchar(320) NOT NULL,
        "provider" varchar(64) NOT NULL,
        "childId" varchar(255) NOT NULL,
        "payloadHash" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "occurredAt" timestamp NOT NULL,
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_delegation_observation_identity"
          UNIQUE ("stepAttemptId", "observationId"),
        CONSTRAINT "FK_delegation_observation_attempt"
          FOREIGN KEY ("stepAttemptId") REFERENCES "step_attempts" ("id")
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_delegation_observation_attempt"
        ON "delegation_observations" ("stepAttemptId", "receivedAt", "id");
      CREATE TABLE IF NOT EXISTS "delegation_observation_conflicts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stepAttemptId" uuid NOT NULL,
        "executionId" uuid NOT NULL,
        "observationId" varchar(320) NOT NULL,
        "payloadHash" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "conflictKind" varchar(32) NOT NULL,
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_delegation_observation_conflict_attempt"
          FOREIGN KEY ("stepAttemptId") REFERENCES "step_attempts" ("id")
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_delegation_observation_conflict_attempt"
        ON "delegation_observation_conflicts" ("stepAttemptId", "receivedAt", "id");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "delegation_observation_conflicts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "delegation_observations"`);
  }
}
