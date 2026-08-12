import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * M4-S3: frozen, trusted, versioned policy snapshot. The rules are the
 * exact canonical data the operator configured (never pipeline/runtime
 * metadata); `hash` is the canonical SHA-256 used by every decision.
 * A version may only ever map to ONE rules hash — a rotated configuration
 * must bump the version (deterministic safe failure otherwise).
 */
@Entity("policy_snapshots")
@Unique("UQ_policy_snapshot_version", ["version"])
@Index("IDX_policy_snapshot_hash", ["hash"])
export class PolicySnapshotEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "int" })
  version: number;

  @Column({ type: "char", length: 64 })
  hash: string;

  /** Canonical bounded rule data (never executable). */
  @Column({ type: "jsonb" })
  rules: unknown;

  @CreateDateColumn()
  createdAt: Date;
}
