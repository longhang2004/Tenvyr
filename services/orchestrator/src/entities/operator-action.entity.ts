import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/** M10-S2: durable operator-action audit evidence. */
@Entity("operator_actions")
@Unique("UQ_operator_action_idempotency", ["action", "idempotencyKey"])
@Index("IDX_operator_action_target", ["action", "targetId"])
export class OperatorActionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 64 })
  action: string;

  @Column({ type: "varchar", length: 128 })
  idempotencyKey: string;

  @Column({ type: "varchar", length: 255, default: "local-operator" })
  actor: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  targetId: string;

  /** Bounded, redacted request summary (never secrets). */
  @Column({ type: "jsonb", nullable: true })
  payload: Record<string, unknown>;

  @Column({ type: "jsonb", default: {} })
  outcome: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
