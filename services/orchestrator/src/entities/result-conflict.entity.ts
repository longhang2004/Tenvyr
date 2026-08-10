import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("result_conflicts")
@Index("IDX_result_conflict_invocation_received", ["invocationId", "receivedAt"])
@Index("UQ_result_conflict_delivery", ["sourceAdapter", "sourceScope", "sourceMessageId", "payloadHash"], {
  unique: true,
  where: `"sourceMessageId" IS NOT NULL`,
})
export class ResultConflictEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  invocationId: string;

  @Column({ type: "uuid", nullable: true })
  resultInboxId: string;

  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  @Column({ type: "jsonb", nullable: true })
  payload: Record<string, unknown>;

  @Column({ type: "varchar", length: 50 })
  sourceAdapter: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceScope: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceMessageId: string;

  @Column({ type: "timestamp", default: () => "now()" })
  receivedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
