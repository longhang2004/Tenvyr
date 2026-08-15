import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * P2: authoritative Model Sources (operator configuration).
 *
 * `model_sources` — where Tenvyr may safely discover model identifiers.
 * Credential fields are environment-variable REFERENCES only (values never
 * persist). Catalogs are deliberately NOT stored: they are bounded
 * on-demand projections, never authority, so no catalog table exists.
 */
export class ModelSources1722270019000 implements MigrationInterface {
  name = "ModelSources1722270019000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "model_sources" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "sourceId" varchar(128) NOT NULL,
        "kind" varchar(50) NOT NULL,
        "displayName" varchar(255) NOT NULL,
        "baseUrl" varchar(2048),
        "credentialEnvRef" varchar(255),
        "statusState" varchar(50) NOT NULL DEFAULT 'UNKNOWN',
        "statusReasonCode" varchar(50) NOT NULL DEFAULT 'none',
        "statusTestedAt" timestamp,
        "lastCatalogRefreshAt" timestamp,
        "modelCount" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_model_source_id" UNIQUE ("sourceId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_model_source_kind"
        ON "model_sources" ("kind");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "model_sources"`);
  }
}
