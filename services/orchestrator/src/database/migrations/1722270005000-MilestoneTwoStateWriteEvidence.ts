import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 2E: controlled state-write provenance.
 *
 * One append-only `state_write_evidence` row per canonical successful result
 * with configured `stateWrites` (disposition applied/noop/rejected, prior and
 * resulting semantic state versions, canonical mapping hash or stable
 * rejection code). The unique `resultInboxId` makes duplicate delivery unable
 * to create a second row. No state/output values are stored; the canonical
 * result payload plus the frozen step configuration remain source evidence.
 *
 * No historical backfill: provenance begins with this migration. Foreign keys
 * use NO ACTION so referenced attempts/inbox rows are never silently
 * cascade-deleted.
 */
export class MilestoneTwoStateWriteEvidence1722270005000 implements MigrationInterface {
  name = "MilestoneTwoStateWriteEvidence1722270005000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "state_write_evidence" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "stepAttemptId" uuid NOT NULL,
        "resultInboxId" uuid NOT NULL,
        "priorVersion" integer NOT NULL,
        "resultVersion" integer NOT NULL,
        "disposition" varchar(16) NOT NULL,
        "mappingHash" varchar(64),
        "rejectionCode" varchar(64),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_state_write_evidence_inbox" UNIQUE ("resultInboxId"),
        CONSTRAINT "FK_state_write_evidence_attempt" FOREIGN KEY ("stepAttemptId")
          REFERENCES "step_attempts"("id"),
        CONSTRAINT "FK_state_write_evidence_inbox" FOREIGN KEY ("resultInboxId")
          REFERENCES "result_inbox"("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_state_write_evidence_attempt" ON "state_write_evidence" ("stepAttemptId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_state_write_evidence_execution" ON "state_write_evidence" ("executionId")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "state_write_evidence"`);
  }
}
