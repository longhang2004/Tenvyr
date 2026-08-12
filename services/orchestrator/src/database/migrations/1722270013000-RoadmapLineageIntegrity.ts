import type { MigrationInterface, QueryRunner } from "typeorm";

/** Independent closure migration for M5-M7 durable relations. It upgrades
 * already-applied provisional schemas without fabricating historical facts. */
export class RoadmapLineageIntegrity1722270013000 implements MigrationInterface {
  name = "RoadmapLineageIntegrity1722270013000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "delegation_requests"
        ADD COLUMN IF NOT EXISTS "payloadHash" char(64);
      ALTER TABLE "delegation_requests"
        ADD COLUMN IF NOT EXISTS "authorityDeadlineAt" timestamp;
      ALTER TABLE "executions"
        ADD COLUMN IF NOT EXISTS "authorityDeadlineAt" timestamp;

      CREATE TABLE IF NOT EXISTS "delegation_request_conflicts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "parentAttemptId" uuid NOT NULL,
        "requestId" varchar(255) NOT NULL,
        "payloadHash" char(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "conflictKind" varchar(32) NOT NULL,
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_delegation_request_conflict_kind"
          CHECK ("conflictKind" IN ('PAYLOAD_MISMATCH', 'LEGACY_PAYLOAD_UNKNOWN'))
      );
      ALTER TABLE "delegation_request_conflicts"
        DROP CONSTRAINT IF EXISTS "CHK_delegation_request_conflict_kind";
      ALTER TABLE "delegation_request_conflicts"
        ADD CONSTRAINT "CHK_delegation_request_conflict_kind"
        CHECK ("conflictKind" IN ('PAYLOAD_MISMATCH', 'LEGACY_PAYLOAD_UNKNOWN'));
      CREATE INDEX IF NOT EXISTS "IDX_delegation_request_conflict_identity"
        ON "delegation_request_conflicts"
        ("parentAttemptId", "requestId", "receivedAt", "id");

      ALTER TABLE "delegation_observations"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_attempt";
      ALTER TABLE "delegation_observations"
        ADD CONSTRAINT "FK_delegation_observation_attempt"
        FOREIGN KEY ("stepAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_observation_conflicts"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_conflict_attempt";
      ALTER TABLE "delegation_observation_conflicts"
        ADD CONSTRAINT "FK_delegation_observation_conflict_attempt"
        FOREIGN KEY ("stepAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_requests"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_parent_attempt";
      ALTER TABLE "delegation_requests"
        ADD CONSTRAINT "FK_delegation_request_parent_attempt"
        FOREIGN KEY ("parentAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE NO ACTION;

      ALTER TABLE "plan_proposals"
        DROP CONSTRAINT IF EXISTS "FK_plan_proposal_execution";
      ALTER TABLE "plan_proposals"
        ADD CONSTRAINT "FK_plan_proposal_execution"
        FOREIGN KEY ("executionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_observations"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_execution";
      ALTER TABLE "delegation_observations"
        ADD CONSTRAINT "FK_delegation_observation_execution"
        FOREIGN KEY ("executionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_observation_conflicts"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_conflict_execution";
      ALTER TABLE "delegation_observation_conflicts"
        ADD CONSTRAINT "FK_delegation_observation_conflict_execution"
        FOREIGN KEY ("executionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_requests"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_parent_execution";
      ALTER TABLE "delegation_requests"
        ADD CONSTRAINT "FK_delegation_request_parent_execution"
        FOREIGN KEY ("parentExecutionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_requests"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_child_execution";
      ALTER TABLE "delegation_requests"
        ADD CONSTRAINT "FK_delegation_request_child_execution"
        FOREIGN KEY ("childExecutionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "delegation_request_conflicts"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_conflict_attempt";
      ALTER TABLE "delegation_request_conflicts"
        ADD CONSTRAINT "FK_delegation_request_conflict_attempt"
        FOREIGN KEY ("parentAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "execution_exports"
        DROP CONSTRAINT IF EXISTS "FK_execution_export_execution";
      ALTER TABLE "execution_exports"
        ADD CONSTRAINT "FK_execution_export_execution"
        FOREIGN KEY ("executionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "execution_replays"
        DROP CONSTRAINT IF EXISTS "FK_execution_replay_source";
      ALTER TABLE "execution_replays"
        ADD CONSTRAINT "FK_execution_replay_source"
        FOREIGN KEY ("sourceExecutionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;
      ALTER TABLE "execution_replays"
        DROP CONSTRAINT IF EXISTS "FK_execution_replay_target";
      ALTER TABLE "execution_replays"
        ADD CONSTRAINT "FK_execution_replay_target"
        FOREIGN KEY ("targetExecutionId") REFERENCES "executions" ("id")
        ON DELETE NO ACTION;

      CREATE INDEX IF NOT EXISTS "IDX_delegation_request_parent_execution"
        ON "delegation_requests" ("parentExecutionId", "createdAt", "id");
      CREATE INDEX IF NOT EXISTS "IDX_delegation_request_child_execution"
        ON "delegation_requests" ("childExecutionId")
        WHERE "childExecutionId" IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "IDX_execution_export_execution"
        ON "execution_exports" ("executionId", "createdAt", "id");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_execution_export_execution";
      DROP INDEX IF EXISTS "IDX_delegation_request_child_execution";
      DROP INDEX IF EXISTS "IDX_delegation_request_parent_execution";
      ALTER TABLE "execution_replays"
        DROP CONSTRAINT IF EXISTS "FK_execution_replay_target";
      ALTER TABLE "execution_replays"
        DROP CONSTRAINT IF EXISTS "FK_execution_replay_source";
      ALTER TABLE "execution_exports"
        DROP CONSTRAINT IF EXISTS "FK_execution_export_execution";
      ALTER TABLE "delegation_requests"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_child_execution";
      ALTER TABLE "delegation_requests"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_parent_execution";
      ALTER TABLE "delegation_observation_conflicts"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_conflict_execution";
      ALTER TABLE "delegation_observations"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_execution";
      ALTER TABLE "plan_proposals"
        DROP CONSTRAINT IF EXISTS "FK_plan_proposal_execution";
      ALTER TABLE "delegation_requests"
        DROP CONSTRAINT IF EXISTS "FK_delegation_request_parent_attempt";
      ALTER TABLE "delegation_requests"
        ADD CONSTRAINT "FK_delegation_request_parent_attempt"
        FOREIGN KEY ("parentAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE CASCADE;
      ALTER TABLE "delegation_observation_conflicts"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_conflict_attempt";
      ALTER TABLE "delegation_observation_conflicts"
        ADD CONSTRAINT "FK_delegation_observation_conflict_attempt"
        FOREIGN KEY ("stepAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE CASCADE;
      ALTER TABLE "delegation_observations"
        DROP CONSTRAINT IF EXISTS "FK_delegation_observation_attempt";
      ALTER TABLE "delegation_observations"
        ADD CONSTRAINT "FK_delegation_observation_attempt"
        FOREIGN KEY ("stepAttemptId") REFERENCES "step_attempts" ("id")
        ON DELETE CASCADE;
      DROP TABLE IF EXISTS "delegation_request_conflicts";
      ALTER TABLE "executions"
        DROP COLUMN IF EXISTS "authorityDeadlineAt";
      ALTER TABLE "delegation_requests"
        DROP COLUMN IF EXISTS "authorityDeadlineAt";
      ALTER TABLE "delegation_requests" DROP COLUMN IF EXISTS "payloadHash";
    `);
  }
}
