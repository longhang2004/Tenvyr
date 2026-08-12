import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { BudgetSource, LedgerOperation } from "../domain/budget";

/**
 * M4-S1: append-only budget ledger evidence. Entries never mutate or delete
 * prior evidence; the current balance is a projection of ledger truth.
 * A reservation debits its account AND every ancestor account (one entry
 * per account); release credits the unused amount back on the same chain;
 * commit records actual/estimated usage evidence without moving
 * availability; adjust applies a signed ceiling correction.
 */
@Entity("budget_ledger_entries")
@Unique("UQ_budget_entry_account_key", ["accountId", "idempotencyKey"])
@Index("IDX_budget_entry_account_created", ["accountId", "createdAt"])
@Index("IDX_budget_entry_reservation", ["reservationId"])
export class BudgetLedgerEntryEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  accountId: string;

  @Column({ type: "uuid", nullable: true })
  reservationId: string | null;

  @Column({ type: "varchar", length: 16 })
  operation: LedgerOperation;

  @Column({ type: "varchar", length: 32 })
  dimension: string;

  /** Positive magnitude in canonical base units. */
  @Column({ type: "bigint" })
  amount: string;

  /** Signed adjust delta (adjust operations only). */
  @Column({ type: "bigint", nullable: true })
  delta: string | null;

  /** actual | estimated | unknown — unknown is never treated as zero. */
  @Column({ type: "varchar", length: 16 })
  source: BudgetSource;

  /** Optional 0..100 confidence for estimated usage. */
  @Column({ type: "smallint", nullable: true })
  confidence: number | null;

  /** Idempotency key of the owning operation (reserve/commit/release). */
  @Column({ type: "varchar", length: 255, nullable: true })
  idempotencyKey: string | null;

  /** Bounded, secret-free context (never action parameters). */
  @Column({ type: "jsonb", nullable: true })
  evidence: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
