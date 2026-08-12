import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 4A: append-only budget ledger.
 *
 * `budget_accounts` — immutable grant ceilings per dimension, optional soft
 * ceilings, and an optional parent scope for hierarchy. `budget_reservations`
 * — one idempotent pre-authorized maximum per operation (unique key: one key
 * can never reserve twice; a conflicting request is rejected and the first
 * reservation stays authoritative). `budget_ledger_entries` — append-only
 * reserve/commit/release/adjust evidence per account; a reservation debits
 * its account AND every ancestor (one entry per account), release credits
 * the unused amount back, commit records actual/estimated usage without
 * moving availability, adjust applies a signed correction. Amounts are
 * canonical integers (bigint); no binary floating-point money.
 *
 * No historical backfill: the ledger begins with this migration. Foreign
 * keys use NO ACTION so referenced rows are never silently cascade-deleted.
 */
export class MilestoneFourBudgetLedger1722270006000 implements MigrationInterface {
  name = "MilestoneFourBudgetLedger1722270006000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "pipelines"
        ADD COLUMN IF NOT EXISTS "budget" jsonb;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "budget_accounts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "scopeType" varchar(32) NOT NULL,
        "scopeId" varchar(255) NOT NULL,
        "parentAccountId" uuid,
        "ceilings" jsonb NOT NULL,
        "softCeilings" jsonb,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_budget_account_scope" UNIQUE ("scopeType", "scopeId"),
        CONSTRAINT "FK_budget_account_parent" FOREIGN KEY ("parentAccountId")
          REFERENCES "budget_accounts" ("id") ON DELETE NO ACTION
      );
      CREATE INDEX IF NOT EXISTS "IDX_budget_account_parent"
        ON "budget_accounts" ("parentAccountId");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "budget_reservations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "accountId" uuid NOT NULL,
        "idempotencyKey" varchar(255) NOT NULL,
        "dimension" varchar(32) NOT NULL,
        "amount" bigint NOT NULL,
        "status" varchar(16) NOT NULL,
        "actionRef" varchar(255),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_budget_reservation_key" UNIQUE ("idempotencyKey"),
        CONSTRAINT "FK_budget_reservation_account" FOREIGN KEY ("accountId")
          REFERENCES "budget_accounts" ("id") ON DELETE NO ACTION,
        CONSTRAINT "CHK_budget_reservation_status"
          CHECK ("status" IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'ADJUSTED')),
        CONSTRAINT "CHK_budget_reservation_amount" CHECK ("amount" > 0)
      );
      CREATE INDEX IF NOT EXISTS "IDX_budget_reservation_account_status"
        ON "budget_reservations" ("accountId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_budget_reservation_action_ref"
        ON "budget_reservations" ("actionRef");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "budget_ledger_entries" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "accountId" uuid NOT NULL,
        "reservationId" uuid,
        "operation" varchar(16) NOT NULL,
        "dimension" varchar(32) NOT NULL,
        "amount" bigint NOT NULL,
        "delta" bigint,
        "source" varchar(16) NOT NULL,
        "confidence" smallint,
        "idempotencyKey" varchar(255),
        "evidence" jsonb,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_budget_entry_account_key" UNIQUE ("accountId", "idempotencyKey"),
        CONSTRAINT "FK_budget_entry_account" FOREIGN KEY ("accountId")
          REFERENCES "budget_accounts" ("id") ON DELETE NO ACTION,
        CONSTRAINT "FK_budget_entry_reservation" FOREIGN KEY ("reservationId")
          REFERENCES "budget_reservations" ("id") ON DELETE NO ACTION,
        CONSTRAINT "CHK_budget_entry_operation"
          CHECK ("operation" IN ('reserve', 'commit', 'release', 'adjust')),
        CONSTRAINT "CHK_budget_entry_source"
          CHECK ("source" IN ('actual', 'estimated', 'unknown')),
        CONSTRAINT "CHK_budget_entry_amount" CHECK ("amount" > 0),
        CONSTRAINT "CHK_budget_entry_confidence"
          CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100))
      );
      CREATE INDEX IF NOT EXISTS "IDX_budget_entry_account_created"
        ON "budget_ledger_entries" ("accountId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_budget_entry_reservation"
        ON "budget_ledger_entries" ("reservationId");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pipelines" DROP COLUMN IF EXISTS "budget"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "budget_ledger_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "budget_reservations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "budget_accounts"`);
  }
}
