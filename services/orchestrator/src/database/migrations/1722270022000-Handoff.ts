import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PP1 Slice C: Portable Handoff V1.
 *
 * `handoffs` — one durable record per continuation: the bounded
 * HandoffBundleV1 (hash + strict-parsed jsonb) from a TERMINAL source run
 * to a NEW destination execution. Idempotent per (sourceExecutionId,
 * bundleHash); the source execution's historical runtime/model identity is
 * never rewritten. Durable truth → included in backup/recovery (M11).
 */
export class Handoff1722270022000 implements MigrationInterface {
  name = "Handoff1722270022000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "handoffs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "sourceExecutionId" uuid NOT NULL,
        "sourceRunId" uuid,
        "bundleHash" char(64) NOT NULL,
        "bundle" jsonb NOT NULL,
        "destinationExecutionId" uuid NOT NULL,
        "requester" varchar(50) NOT NULL DEFAULT 'operator',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_handoff_source_bundle" UNIQUE ("sourceExecutionId", "bundleHash")
      );
      CREATE INDEX IF NOT EXISTS "IDX_handoff_destination"
        ON "handoffs" ("destinationExecutionId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "handoffs"`);
  }
}