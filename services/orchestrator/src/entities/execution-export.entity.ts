import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * M7-S2: a SMALL immutable export manifest. It pins the source execution
 * to the exact capsule content hash — it never duplicates execution
 * truth (no plan/attempt/event payloads). Re-exporting the same
 * execution at the same capsule hash is idempotent.
 */
@Entity("execution_exports")
@Unique("UQ_execution_export_capsule", ["executionId", "capsuleHash"])
@Index("IDX_execution_export_created", ["createdAt", "id"])
export class ExecutionExportEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  executionId: string;

  /** The source capsule's stable content hash (the manifest pin). */
  @Column({ type: "char", length: 64 })
  capsuleHash: string;

  @Column({ type: "varchar", length: 50, default: "operator" })
  exporter: string;

  @Column({ type: "text", nullable: true })
  note: string;

  @CreateDateColumn()
  createdAt: Date;
}
