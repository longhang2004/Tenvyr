import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

export type ResultInboxStatus = "RECEIVED" | "APPLIED" | "REJECTED";

@Entity("result_inbox")
@Unique("UQ_result_inbox_invocation", ["invocationId"])
@Index("IDX_result_inbox_status_received", ["status", "receivedAt"])
@Index("IDX_result_inbox_attempt", ["stepAttemptId"])
@Index("UQ_result_inbox_transport", ["sourceAdapter", "sourceScope", "sourceMessageId"], {
  unique: true,
  where: `"sourceMessageId" IS NOT NULL`,
})
export class ResultInboxEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  invocationId: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  @Column({ type: "varchar", length: 50 })
  sourceAdapter: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceScope: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceMessageId: string;

  @Column({ type: "varchar", length: 50, default: "RECEIVED" })
  status: ResultInboxStatus;

  @Column({ type: "timestamp", default: () => "now()" })
  receivedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  appliedAt: Date;

  @Column({ type: "text", nullable: true })
  lastApplicationError: string;

  @CreateDateColumn()
  createdAt: Date;
}
