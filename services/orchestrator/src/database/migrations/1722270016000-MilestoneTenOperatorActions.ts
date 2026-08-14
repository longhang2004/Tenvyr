import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 10A: durable operator-action audit evidence.
 *
 * Every Workbench command records one row (actor, action, idempotency
 * key, bounded redacted payload, outcome). `UNIQUE (action,
 * idempotencyKey)` makes command delivery exactly-once: a duplicate
 * delivery returns the stored outcome instead of re-executing authority.
 * Initial actor is the single local operator — no multi-user identity is
 * fabricated.
 */
export class MilestoneTenOperatorActions1722270016000
  implements MigrationInterface
{
  name = "MilestoneTenOperatorActions1722270016000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "operator_actions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "action" varchar(64) NOT NULL,
        "idempotencyKey" varchar(128) NOT NULL,
        "actor" varchar(255) NOT NULL DEFAULT 'local-operator',
        "targetId" varchar(255),
        "payload" jsonb,
        "outcome" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_operator_action_idempotency"
          UNIQUE ("action", "idempotencyKey")
      );
      CREATE INDEX IF NOT EXISTS "IDX_operator_action_target"
        ON "operator_actions" ("action", "targetId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "operator_actions";
    `);
  }
}
