import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * M4-S1: one durable budget scope whose ceiling is inherited from a parent
 * account. `ceilings` (immutable grant) and `softCeilings` (policy trigger)
 * are stored as canonical integer amounts per dimension; every change after
 * creation flows through append-only ledger entries.
 */
@Entity("budget_accounts")
@Unique("UQ_budget_account_scope", ["scopeType", "scopeId"])
@Index("IDX_budget_account_parent", ["parentAccountId"])
export class BudgetAccountEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 32 })
  scopeType: string;

  @Column({ type: "varchar", length: 255 })
  scopeId: string;

  @Column({ type: "uuid", nullable: true })
  parentAccountId: string | null;

  /** Immutable grant: { dimension: canonical integer amount }. */
  @Column({ type: "jsonb" })
  ceilings: Record<string, number>;

  /** Optional per-dimension soft ceilings: { dimension: amount }. */
  @Column({ type: "jsonb", nullable: true })
  softCeilings: Record<string, number> | null;

  @CreateDateColumn()
  createdAt: Date;
}
