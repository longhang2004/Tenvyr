import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Milestone 2B: durable semantic ExecutionState on the executions row.
 *
 * Adds the three ExecutionState columns to `executions`:
 * - `executionState` jsonb NOT NULL DEFAULT '{}' — the top-level state object;
 * - `executionStateVersion` integer NOT NULL DEFAULT 0 — the explicit
 *   semantic state version, incremented exactly once per real mutation;
 * - `executionStateUpdatedAt` timestamp NULL — set only by real mutations.
 *
 * Existing rows automatically receive `{}` at semantic version 0 via the ADD
 * COLUMN defaults; no backfill statement is needed or performed. The default
 * must mirror the TypeORM entity metadata so disposable synchronize-based
 * tests build the same schema.
 *
 * `executionStateVersion` is NOT the TypeORM `rowVersion` column: rowVersion
 * guards the whole row; the semantic version guards ExecutionState only.
 */
export class MilestoneTwoExecutionState1722270003000 implements MigrationInterface {
  name = "MilestoneTwoExecutionState1722270003000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "executionState" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "executionStateVersion" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "executionStateUpdatedAt" timestamp`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN IF EXISTS "executionState"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN IF EXISTS "executionStateVersion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN IF EXISTS "executionStateUpdatedAt"`,
    );
  }
}
