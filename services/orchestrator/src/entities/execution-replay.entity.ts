import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * M7-S2: a controlled replay request. Links a source execution + capsule
 * hash to a NEW target execution, idempotently (one replay per
 * source/capsule pair). The target is materialized from the CAPTURED
 * plan revision (never the current pipeline) with the captured input;
 * all authority (policy/budget/credentials) is re-evaluated by the
 * normal claim machinery — historical approvals are never copied.
 */
@Entity("execution_replays")
@Unique("UQ_execution_replay_source", ["sourceExecutionId", "sourceCapsuleHash"])
@Index("IDX_execution_replay_target", ["targetExecutionId"])
export class ExecutionReplayEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  sourceExecutionId: string;

  /** The source capsule content hash this replay reproduces. */
  @Column({ type: "char", length: 64 })
  sourceCapsuleHash: string;

  /** The new execution created by this replay. */
  @Column({ type: "uuid" })
  targetExecutionId: string;

  @Column({ type: "varchar", length: 50, default: "operator" })
  requester: string;

  @Column({ type: "text", nullable: true })
  note: string;

  @CreateDateColumn()
  createdAt: Date;
}
