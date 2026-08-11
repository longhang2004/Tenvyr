import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 2A: durable Artifact reference identities and producer lineage.
 *
 * One immutable `artifacts` row per canonical result descriptor
 * (result_inbox.payload.artifacts[i]). The worker-supplied descriptor stays in
 * the canonical inbox payload; this table persists only the Tenvyr-owned
 * identity index: the ResultInbox reference, the descriptor ordinal, and the
 * canonical descriptor hash. Uniqueness over (resultInboxId,
 * descriptorOrdinal) makes duplicate registration of the same canonical
 * descriptor impossible. Insert-only: no update path exists.
 *
 * No historical backfill: artifact identity begins with this migration; pre-
 * existing APPLIED ResultInbox rows keep their payloads but get no Artifact
 * rows. Referential deletion mirrors agent_events: a deleted ResultInbox row
 * (never done by current code) cascades to its Artifact index rows.
 */
export class MilestoneTwoArtifactIdentity1722270002000 implements MigrationInterface {
  name = "MilestoneTwoArtifactIdentity1722270002000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "artifacts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "resultInboxId" uuid NOT NULL,
        "descriptorOrdinal" integer NOT NULL,
        "descriptorHash" varchar(64) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_artifact_inbox_ordinal" UNIQUE ("resultInboxId", "descriptorOrdinal"),
        CONSTRAINT "FK_artifact_inbox" FOREIGN KEY ("resultInboxId")
          REFERENCES "result_inbox"("id") ON DELETE CASCADE
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "artifacts"`);
  }
}
