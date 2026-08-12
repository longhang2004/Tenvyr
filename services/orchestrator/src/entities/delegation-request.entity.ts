import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import { StepAttemptEntity } from "./step-attempt.entity";

export type DelegationRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED";

/**
 * M6-S2: an authoritative supervised-delegation request, scoped to ONE
 * parent attempt and idempotent per (parentAttemptId, requestId). The
 * decision (APPROVED/REJECTED) is terminal; approval materializes the
 * child Execution and links it via childExecutionId in the SAME
 * transaction — all-or-none. Expiry is deterministic; the recovery sweep
 * terminalizes due requests.
 */
@Entity("delegation_requests")
@Unique("UQ_delegation_request_identity", ["parentAttemptId", "requestId"])
@Index("IDX_delegation_request_status_expiry", ["status", "expiresAt"])
export class DelegationRequestEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  parentExecutionId: string;

  @Column({ type: "uuid" })
  parentAttemptId: string;

  @ManyToOne(() => StepAttemptEntity, { onDelete: "NO ACTION" })
  @JoinColumn({ name: "parentAttemptId" })
  parentAttempt: StepAttemptEntity;

  /** Runtime-provided bounded reference, unique per parent attempt. */
  @Column({ type: "varchar", length: 255 })
  requestId: string;

  /** The requested child agent (bounded; the child pipeline resolves it). */
  @Column({ type: "varchar", length: 255 })
  requestedAgent: string;

  /** Canonical request payload identity. Null only for pre-closure rows. */
  @Column({ type: "char", length: 64, nullable: true })
  payloadHash: string | null;

  /** M6-S4: server-derived delegation depth (parent depth + 1). */
  @Column({ type: "integer", default: 1 })
  childDepth: number;

  /** Set atomically with the APPROVED decision (the relation). */
  @Column({ type: "uuid", nullable: true })
  childExecutionId: string | null;

  @Column({ type: "varchar", length: 20, default: "PENDING" })
  status: DelegationRequestStatus;

  @Column({ type: "text", nullable: true })
  decisionNote: string;

  @Column({ type: "timestamp" })
  expiresAt: Date;

  /** Frozen parent-attempt deadline inherited by the child execution. */
  @Column({ type: "timestamp", nullable: true })
  authorityDeadlineAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  decidedAt: Date | null;
}
