import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

export type DispatchOutboxStatus =
  | "PENDING"
  | "LEASED"
  | "DISPATCHED"
  | "COMPLETED"
  | "FAILED";

@Entity("dispatch_outbox")
@Unique("UQ_dispatch_outbox_attempt", ["stepAttemptId"])
@Index("IDX_dispatch_outbox_status_next", ["status", "nextDispatchAt"])
@Index("IDX_dispatch_outbox_lease", ["leaseExpiresAt"])
export class DispatchOutboxEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @Column({ type: "jsonb" })
  invocation: Record<string, unknown>;

  @Column({ type: "varchar", length: 50, default: "PENDING" })
  status: DispatchOutboxStatus;

  @Column({ type: "timestamp", default: () => "now()" })
  nextDispatchAt: Date;

  @Column({ type: "timestamp", nullable: true })
  leaseExpiresAt: Date;

  @Column({ type: "varchar", length: 36, nullable: true })
  leaseToken: string;

  @Column({ type: "integer", default: 0 })
  dispatchCount: number;

  @Column({ type: "jsonb", nullable: true })
  receipt: Record<string, unknown>;

  @Column({ type: "text", nullable: true })
  error: string;

  @CreateDateColumn()
  createdAt: Date;
}
