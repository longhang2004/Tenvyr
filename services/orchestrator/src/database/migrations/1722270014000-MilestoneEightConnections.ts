import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 8A: durable Runtime Connections and immutable revisions.
 *
 * `runtime_connections` — operator-owned connection rows: logical
 * `connectionId`, runtime kind, executor selection, bounded status
 * projection, and the current revision number.
 * `connection_revisions` — IMMUTABLE secret-free configuration revisions.
 * A database trigger blocks UPDATE/DELETE so no code path can rewrite a
 * frozen revision; attempts freeze the exact revision number and the
 * canonical config hash, never mutable latest state.
 */
export class MilestoneEightConnections1722270014000
  implements MigrationInterface
{
  name = "MilestoneEightConnections1722270014000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "runtime_connections" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "connectionId" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "runtimeKind" varchar(50) NOT NULL,
        "executorId" varchar(255) NOT NULL,
        "version" varchar(128),
        "currentRevisionNumber" integer NOT NULL DEFAULT 0,
        "statusState" varchar(50) NOT NULL DEFAULT 'DRAFT',
        "statusReasonCode" varchar(50) NOT NULL DEFAULT 'none',
        "statusTestedAt" timestamp,
        "statusTestedVersion" varchar(128),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_runtime_connection_id" UNIQUE ("connectionId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_runtime_connection_kind"
        ON "runtime_connections" ("runtimeKind");
      CREATE TABLE IF NOT EXISTS "connection_revisions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "connectionId" varchar(255) NOT NULL,
        "revisionNumber" integer NOT NULL,
        "profile" jsonb NOT NULL,
        "configHash" char(64) NOT NULL,
        "capabilities" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_connection_revision_number"
          UNIQUE ("connectionId", "revisionNumber"),
        CONSTRAINT "FK_connection_revision_connection"
          FOREIGN KEY ("connectionId")
          REFERENCES "runtime_connections"("connectionId") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_connection_revision_connection"
        ON "connection_revisions" ("connectionId", "revisionNumber");
      CREATE OR REPLACE FUNCTION "block_connection_revision_mutation"()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'connection revisions are immutable';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS "TRG_connection_revision_immutable"
        ON "connection_revisions";
      CREATE TRIGGER "TRG_connection_revision_immutable"
        BEFORE UPDATE OR DELETE ON "connection_revisions"
        FOR EACH ROW EXECUTE FUNCTION "block_connection_revision_mutation"();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_connection_revision_immutable"
        ON "connection_revisions";
      DROP FUNCTION IF EXISTS "block_connection_revision_mutation"();
      DROP TABLE IF EXISTS "connection_revisions";
      DROP TABLE IF EXISTS "runtime_connections";
    `);
  }
}
