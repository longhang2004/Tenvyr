import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 1: durable operational AgentEvents and attempt liveness projection.
 *
 * agent_events is append-only operational evidence, never authoritative
 * lifecycle state: AgentResult remains the only worker-originated terminal
 * authority. Event identity within one attempt is (stepAttemptId, eventId);
 * sequence is the worker-produced logical order. Both are unique, so
 * duplicated deliveries are idempotent and conflicting identity/sequence is
 * retained as evidence in agent_event_conflicts instead of overwriting the
 * canonical row.
 *
 * The step_attempts liveness columns are SERVER-received timestamps
 * (receivedAt-derived), used by deterministic supervision; worker clocks are
 * only audit evidence.
 */
export class MilestoneOneAgentEvents1722270001000 implements MigrationInterface {
  name = "MilestoneOneAgentEvents1722270001000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stepAttemptId" uuid NOT NULL,
        "invocationId" varchar(255) NOT NULL,
        "executionId" uuid NOT NULL,
        "logicalStepId" uuid NOT NULL,
        "eventId" varchar(255) NOT NULL,
        "sequence" integer NOT NULL,
        "type" varchar(50) NOT NULL,
        "payload" jsonb NOT NULL,
        "metadata" jsonb,
        "trace" jsonb NOT NULL,
        "payloadHash" varchar(64) NOT NULL,
        "occurredAt" timestamp NOT NULL,
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        "sourceAdapter" varchar(50) NOT NULL,
        "sourceScope" varchar(255),
        "sourceMessageId" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_agent_event_identity" UNIQUE ("stepAttemptId", "eventId"),
        CONSTRAINT "UQ_agent_event_sequence" UNIQUE ("stepAttemptId", "sequence"),
        CONSTRAINT "FK_agent_event_attempt" FOREIGN KEY ("stepAttemptId")
          REFERENCES "step_attempts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_event_transport"
        ON "agent_events" ("sourceAdapter", "sourceScope", "sourceMessageId")
        WHERE "sourceMessageId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_event_execution_received"
        ON "agent_events" ("executionId", "receivedAt", "id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_event_attempt_received"
        ON "agent_events" ("stepAttemptId", "receivedAt", "id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_event_heartbeat_lookup"
        ON "agent_events" ("stepAttemptId", "receivedAt")
        WHERE "type" = 'heartbeat'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_event_conflicts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stepAttemptId" uuid NOT NULL,
        "invocationId" varchar(255) NOT NULL,
        "eventId" varchar(255) NOT NULL,
        "sequence" integer NOT NULL,
        "conflictKind" varchar(50) NOT NULL,
        "payloadHash" varchar(64) NOT NULL,
        "payload" jsonb,
        "sourceAdapter" varchar(50) NOT NULL,
        "sourceScope" varchar(255),
        "sourceMessageId" varchar(255),
        "receivedAt" timestamp NOT NULL DEFAULT now(),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_agent_event_conflict_attempt" FOREIGN KEY ("stepAttemptId")
          REFERENCES "step_attempts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_event_conflict_attempt_received"
        ON "agent_event_conflicts" ("stepAttemptId", "receivedAt")
    `);

    // Server-received liveness projection on the active StepAttempt. Only
    // updated while the attempt is non-terminal; late events after a terminal
    // result remain append-only evidence and never touch these columns.
    await queryRunner.query(
      `ALTER TABLE "step_attempts" ADD COLUMN IF NOT EXISTS "acceptedAt" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_attempts" ADD COLUMN IF NOT EXISTS "lastEventReceivedAt" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_attempts" ADD COLUMN IF NOT EXISTS "lastHeartbeatReceivedAt" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_attempts" ADD COLUMN IF NOT EXISTS "lastProgressReceivedAt" timestamp`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "step_attempts" DROP COLUMN IF EXISTS "lastProgressReceivedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_attempts" DROP COLUMN IF EXISTS "lastHeartbeatReceivedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_attempts" DROP COLUMN IF EXISTS "lastEventReceivedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_attempts" DROP COLUMN IF EXISTS "acceptedAt"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_event_conflicts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_events"`);
  }
}
