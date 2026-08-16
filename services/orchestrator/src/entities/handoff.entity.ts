import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * PP1 Slice C: one durable HandoffBundle record — the bounded projection
 * that let a NEW Team Run continue work started by a TERMINAL source run.
 * Mirrors the ExecutionReplay lineage pattern: idempotent per
 * (sourceExecutionId, bundleHash); the destination execution is a NEW
 * execution and the source's historical runtime/model identity is never
 * rewritten. Durable truth → included in backup/recovery.
 */
@Entity("handoffs")
@Unique("UQ_handoff_source_bundle", ["sourceExecutionId", "bundleHash"])
@Index("IDX_handoff_destination", ["destinationExecutionId"])
export class HandoffEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  sourceExecutionId: string;

  @Column({ type: "uuid", nullable: true })
  sourceRunId: string | null;

  /** SHA-256 of the canonical HandoffBundleV1. */
  @Column({ type: "char", length: 64 })
  bundleHash: string;

  /** The bounded HandoffBundleV1 (strictly parsed on read). */
  @Column({ type: "jsonb" })
  bundle: Record<string, unknown>;

  @Column({ type: "uuid" })
  destinationExecutionId: string;

  @Column({ type: "varchar", length: 50, default: "operator" })
  requester: string;

  @CreateDateColumn()
  createdAt: Date;
}