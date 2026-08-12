import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 4B: policy decision boundary.
 *
 * `policy_snapshots` — frozen trusted rule data per version (one hash per
 * version; rotation must bump the version). `policy_decisions` — append-only
 * evidence for every intercepted action: proposal hash, bounded facts,
 * policy version/hash, effect, reasons, timestamps. Decisions commit
 * atomically with the intercepted action's transaction.
 */
export class MilestoneFourPolicy1722270007000 implements MigrationInterface {
  name = "MilestoneFourPolicy1722270007000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "policy_snapshots" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "version" int NOT NULL,
        "hash" char(64) NOT NULL,
        "rules" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_policy_snapshot_version" UNIQUE ("version")
      );
      CREATE INDEX IF NOT EXISTS "IDX_policy_snapshot_hash"
        ON "policy_snapshots" ("hash");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "policy_decisions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "proposalId" varchar(64) NOT NULL,
        "actionType" varchar(32) NOT NULL,
        "executionId" varchar(255) NOT NULL,
        "logicalStepId" varchar(255),
        "attemptNumber" int,
        "targetAgent" varchar(255),
        "targetExecutor" varchar(255),
        "proposalHash" char(64) NOT NULL,
        "policyVersion" int NOT NULL,
        "policyHash" char(64) NOT NULL,
        "effect" varchar(16) NOT NULL,
        "reasons" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_policy_decision_effect"
          CHECK ("effect" IN ('ALLOW', 'DENY', 'REQUIRE_APPROVAL'))
      );
      CREATE INDEX IF NOT EXISTS "IDX_policy_decision_scope"
        ON "policy_decisions" ("executionId", "logicalStepId");
      CREATE INDEX IF NOT EXISTS "IDX_policy_decision_proposal"
        ON "policy_decisions" ("proposalId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "policy_decisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "policy_snapshots"`);
  }
}
