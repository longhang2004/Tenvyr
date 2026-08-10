import type { MigrationInterface, QueryRunner } from "typeorm";

export class MilestoneZeroFoundation1722270000000 implements MigrationInterface {
  name = "MilestoneZeroFoundation1722270000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pipelines" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(255) NOT NULL,
        "version" varchar(50) NOT NULL,
        "description" text,
        "steps" jsonb NOT NULL,
        "schemaVersion" integer NOT NULL DEFAULT 1,
        "contentHash" varchar(64),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "schemaVersion" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "contentHash" varchar(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pipelines_name_version" ON "pipelines" ("name", "version")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "pipelineId" uuid NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'PENDING',
        "input" jsonb NOT NULL,
        "output" jsonb,
        "startTime" timestamp,
        "endTime" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "pipelineVersion" varchar(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "pipelineHash" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "configurationSnapshot" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "activePlanRevisionId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "terminationReason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "rowVersion" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_executions_pipeline_status" ON "executions" ("pipelineId", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "step_executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "stepId" varchar(100) NOT NULL,
        "agent" varchar(100) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'PENDING',
        "input" jsonb,
        "output" jsonb,
        "error" text,
        "attempt" integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 0,
        "startTime" timestamp,
        "endTime" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_step_executions_execution_step" UNIQUE ("executionId", "stepId")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "step_executions" ADD COLUMN IF NOT EXISTS "frozenSpecHash" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_executions" ADD COLUMN IF NOT EXISTS "frozenAt" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_executions" ADD COLUMN IF NOT EXISTS "conditionResult" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_executions" ADD COLUMN IF NOT EXISTS "eligibleAt" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_executions" ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_executions" ADD COLUMN IF NOT EXISTS "rowVersion" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_step_executions_execution_status" ON "step_executions" ("executionId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_logical_step_scheduler" ON "step_executions" ("status", "eligibleAt", "nextAttemptAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "execution_plan_revisions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "revisionNumber" integer NOT NULL,
        "parentRevisionId" uuid,
        "baseRevision" integer,
        "plan" jsonb NOT NULL,
        "planHash" varchar(64),
        "source" varchar(50) NOT NULL DEFAULT 'pipeline',
        "reason" text,
        "validationResult" jsonb,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_execution_plan_revision_number" UNIQUE ("executionId", "revisionNumber")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_execution_plan_revision_hash" ON "execution_plan_revisions" ("executionId", "planHash")`,
    );
    await queryRunner.query(
      `ALTER TABLE "execution_plan_revisions" ALTER COLUMN "planHash" DROP NOT NULL`,
    );

    await queryRunner.query(`
      INSERT INTO "execution_plan_revisions" (
        "executionId", "revisionNumber", "plan", "source", "reason", "validationResult"
      )
      SELECT e."id", 1, jsonb_build_object('schemaVersion', 1, 'steps', p."steps"),
             'legacy_backfill', 'Backfilled from mutable pipeline',
             jsonb_build_object('legacy', true, 'planHash', 'unavailable')
      FROM "executions" e
      JOIN "pipelines" p ON p."id" = e."pipelineId"
      WHERE NOT EXISTS (
        SELECT 1 FROM "execution_plan_revisions" r WHERE r."executionId" = e."id"
      )
    `);
    await queryRunner.query(`
      UPDATE "executions" e
      SET "pipelineVersion" = COALESCE(e."pipelineVersion", p."version"),
          "pipelineHash" = COALESCE(e."pipelineHash", p."contentHash", md5(p."steps"::text)),
          "configurationSnapshot" = COALESCE(e."configurationSnapshot", jsonb_build_object(
            'schemaVersion', 1, 'pipelineId', p."id", 'pipelineVersion', p."version",
            'pipelineHash', COALESCE(p."contentHash", md5(p."steps"::text))
          )),
          "activePlanRevisionId" = COALESCE(e."activePlanRevisionId", r."id")
      FROM "pipelines" p, "execution_plan_revisions" r
      WHERE p."id" = e."pipelineId" AND r."executionId" = e."id" AND r."revisionNumber" = 1
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "step_attempts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "logicalStepId" uuid NOT NULL,
        "planRevisionId" uuid NOT NULL,
        "attemptNumber" integer NOT NULL,
        "invocationId" varchar(255) NOT NULL,
        "frozenSpecHash" varchar(64) NOT NULL,
        "inputSnapshot" jsonb,
        "contextSnapshot" jsonb,
        "executorSnapshot" jsonb NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'CREATED',
        "dispatchedAt" timestamp,
        "startTime" timestamp,
        "deadlineAt" timestamp,
        "terminalAt" timestamp,
        "result" jsonb,
        "error" text,
        "terminationReason" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_step_attempt_number" UNIQUE ("logicalStepId", "attemptNumber"),
        CONSTRAINT "UQ_step_attempt_invocation" UNIQUE ("invocationId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_step_attempt_status_deadline" ON "step_attempts" ("status", "deadlineAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_step_attempt_active" ON "step_attempts" ("logicalStepId") WHERE "status" IN ('CREATED', 'DISPATCHED', 'RUNNING')`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dispatch_outbox" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stepAttemptId" uuid NOT NULL,
        "invocation" jsonb NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'PENDING',
        "nextDispatchAt" timestamp NOT NULL DEFAULT now(),
        "leaseExpiresAt" timestamp,
        "leaseToken" varchar(36),
        "dispatchCount" integer NOT NULL DEFAULT 0,
        "receipt" jsonb,
        "error" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_dispatch_outbox_attempt" UNIQUE ("stepAttemptId"),
        CONSTRAINT "FK_dispatch_outbox_attempt" FOREIGN KEY ("stepAttemptId")
          REFERENCES "step_attempts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dispatch_outbox_status_next" ON "dispatch_outbox" ("status", "nextDispatchAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "dispatch_outbox" ADD COLUMN IF NOT EXISTS "leaseToken" varchar(36)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dispatch_outbox_lease" ON "dispatch_outbox" ("leaseExpiresAt")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "result_inbox" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "invocationId" varchar(255) NOT NULL,
        "stepAttemptId" uuid NOT NULL,
        "payloadHash" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "sourceAdapter" varchar(50) NOT NULL,
        "sourceScope" varchar(255),
        "sourceMessageId" varchar(255),
        "status" varchar(50) NOT NULL DEFAULT 'RECEIVED',
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        "appliedAt" timestamp,
        "lastApplicationError" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_result_inbox_invocation" UNIQUE ("invocationId"),
        CONSTRAINT "FK_result_inbox_attempt" FOREIGN KEY ("stepAttemptId")
          REFERENCES "step_attempts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_result_inbox_status_received" ON "result_inbox" ("status", "receivedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_result_inbox_attempt" ON "result_inbox" ("stepAttemptId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_result_inbox_transport" ON "result_inbox" ("sourceAdapter", "sourceScope", "sourceMessageId") WHERE "sourceMessageId" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "result_conflicts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "invocationId" varchar(255) NOT NULL,
        "resultInboxId" uuid,
        "payloadHash" varchar(64) NOT NULL,
        "payload" jsonb,
        "sourceAdapter" varchar(50) NOT NULL,
        "sourceScope" varchar(255),
        "sourceMessageId" varchar(255),
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_result_conflict_inbox" FOREIGN KEY ("resultInboxId")
          REFERENCES "result_inbox"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_result_conflict_invocation_received" ON "result_conflicts" ("invocationId", "receivedAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_result_conflict_delivery" ON "result_conflicts" ("sourceAdapter", "sourceScope", "sourceMessageId", "payloadHash") WHERE "sourceMessageId" IS NOT NULL`,
    );
    // Legacy StepAttempt backfill. Only rows with persisted evidence that an
    // attempt actually existed become StepAttempts; everything else remains
    // materialized scheduling state. The pre-Milestone-0 engine incremented
    // `attempt` at scheduling time (createStepExecution, status PENDING) and
    // only then dispatched and wrote RUNNING/terminal statuses, so:
    //
    //   COMPLETED -> SUCCESS      (attemptNumber = GREATEST(attempt, 1))
    //   FAILED    -> FAILED
    //   CANCELLED -> CANCELLED
    //   RUNNING   -> RUNNING      (genuine in-flight attempt; kept active so
    //                              no second execution identity is invented)
    //
    // PENDING rows (attempt 0 or an incremented counter without a confirmed
    // dispatch), SKIPPED rows, and any other logical-only state are NEVER
    // backfilled: their dispatch outcome is ambiguous or never began, and a
    // fabricated CREATED attempt would block the partial unique active-attempt
    // index for the step's real first claim. The legacy model overwrote retry
    // attempts, so full immutable historical retry history is not
    // reconstructable; the migration preserves only the defensible latest
    // attempt per logical step.
    //
    // A backfilled RUNNING attempt receives a deadlineAt grace window: its
    // invocationId follows the same `<stepExecutionId>:<attempt>` convention
    // the legacy engine used, so a live legacy worker result can still land;
    // if none arrives within the grace window, RuntimeRecoveryService expires
    // it deterministically (TIMED_OUT) instead of leaving the step pinned by
    // the active-attempt index forever. Terminal rows use COALESCE(endTime,
    // now()) because legacy CANCELLED rows never persisted endTime.
    await queryRunner.query(`
      INSERT INTO "step_attempts" (
        "executionId", "logicalStepId", "planRevisionId", "attemptNumber", "invocationId",
        "frozenSpecHash", "inputSnapshot", "executorSnapshot", "status", "startTime",
        "deadlineAt", "terminalAt", "result", "error", "createdAt"
      )
      SELECT s."executionId", s."id", e."activePlanRevisionId", GREATEST(s."attempt", 1),
             s."id" || ':' || GREATEST(s."attempt", 1),
             COALESCE(s."frozenSpecHash", md5(s."stepId" || ':' || s."agent")), s."input",
             jsonb_build_object('agent', s."agent", 'legacy', true),
             CASE s."status"
               WHEN 'COMPLETED' THEN 'SUCCESS'
               WHEN 'FAILED' THEN 'FAILED'
               WHEN 'CANCELLED' THEN 'CANCELLED'
               WHEN 'RUNNING' THEN 'RUNNING'
             END,
             s."startTime",
             CASE WHEN s."status" = 'RUNNING' THEN now() + interval '1 hour' ELSE NULL END,
             CASE WHEN s."status" = 'RUNNING' THEN NULL ELSE COALESCE(s."endTime", now()) END,
             s."output", s."error", s."createdAt"
      FROM "step_executions" s
      JOIN "executions" e ON e."id" = s."executionId"
      WHERE e."activePlanRevisionId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "step_attempts" a WHERE a."logicalStepId" = s."id")
        AND s."status" IN ('COMPLETED', 'FAILED', 'CANCELLED', 'RUNNING')
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "execution_plan_revisions" ADD CONSTRAINT "FK_plan_execution"
          FOREIGN KEY ("executionId") REFERENCES "executions"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "execution_plan_revisions" ADD CONSTRAINT "FK_plan_parent"
          FOREIGN KEY ("parentRevisionId") REFERENCES "execution_plan_revisions"("id");
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "step_attempts" ADD CONSTRAINT "FK_attempt_execution"
          FOREIGN KEY ("executionId") REFERENCES "executions"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "step_attempts" ADD CONSTRAINT "FK_attempt_logical_step"
          FOREIGN KEY ("logicalStepId") REFERENCES "step_executions"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "step_attempts" ADD CONSTRAINT "FK_attempt_plan_revision"
          FOREIGN KEY ("planRevisionId") REFERENCES "execution_plan_revisions"("id");
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const authoritativeAttempts = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM "step_attempts" a
        JOIN "execution_plan_revisions" r ON r."id" = a."planRevisionId"
        WHERE r."source" <> 'legacy_backfill'
      ) AS "hasAuthoritativeAttempts"
    `)) as Array<{ hasAuthoritativeAttempts?: boolean }>;
    if (authoritativeAttempts[0]?.hasAuthoritativeAttempts) {
      throw new Error(
        "Milestone Zero foundation rollback is only supported before immutable runtime attempts exist; apply a forward fix instead.",
      );
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "result_conflicts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "result_inbox"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dispatch_outbox"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "step_attempts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "execution_plan_revisions"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_logical_step_scheduler"`,
    );
    for (const column of [
      "nextAttemptAt",
      "eligibleAt",
      "conditionResult",
      "frozenAt",
      "frozenSpecHash",
      "rowVersion",
    ]) {
      await queryRunner.query(
        `ALTER TABLE "step_executions" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
    for (const column of [
      "terminationReason",
      "activePlanRevisionId",
      "configurationSnapshot",
      "pipelineHash",
      "pipelineVersion",
      "rowVersion",
    ]) {
      await queryRunner.query(
        `ALTER TABLE "executions" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "pipelines" DROP COLUMN IF EXISTS "contentHash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pipelines" DROP COLUMN IF EXISTS "schemaVersion"`,
    );
  }
}
