import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import type {
  ConnectionStatusState,
  RuntimeKind,
  StatusReasonCode,
} from "../executors/runtime-connection";

@Entity("runtime_connections")
@Unique("UQ_runtime_connection_id", ["connectionId"])
@Index("IDX_runtime_connection_kind", ["runtimeKind"])
export class RuntimeConnectionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Stable logical connection identity ("conn:codex-local"). */
  @Column({ type: "varchar", length: 255 })
  connectionId: string;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "varchar", length: 50 })
  runtimeKind: RuntimeKind;

  @Column({ type: "varchar", length: 255 })
  executorId: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  version: string;

  /** Monotonic per connection; revisions are immutable and append-only. */
  @Column({ type: "integer", default: 0 })
  currentRevisionNumber: number;

  /** Bounded status projection; never dispatch authority by itself. */
  @Column({ type: "varchar", length: 50, default: "DRAFT" })
  statusState: ConnectionStatusState;

  @Column({ type: "varchar", length: 50, default: "none" })
  statusReasonCode: StatusReasonCode;

  @Column({ type: "timestamp", nullable: true })
  statusTestedAt: Date;

  @Column({ type: "varchar", length: 128, nullable: true })
  statusTestedVersion: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
