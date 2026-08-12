import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { ReservationStatus } from "../domain/budget";

/**
 * M4-S1: one idempotent pre-authorized maximum for a single operation.
 * An idempotency key can never reserve twice; the same key with a different
 * request conflicts and the conflict is retained (the first reservation
 * stays authoritative).
 */
@Entity("budget_reservations")
@Unique("UQ_budget_reservation_key", ["idempotencyKey"])
@Index("IDX_budget_reservation_account_status", ["accountId", "status"])
export class BudgetReservationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  accountId: string;

  @Column({ type: "varchar", length: 255 })
  idempotencyKey: string;

  @Column({ type: "varchar", length: 32 })
  dimension: string;

  @Column({ type: "bigint" })
  amount: string;

  @Column({ type: "varchar", length: 16 })
  status: ReservationStatus;

  /** Stable reference to the intercepted action (e.g. attempt id). */
  @Column({ type: "varchar", length: 255, nullable: true })
  actionRef: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
