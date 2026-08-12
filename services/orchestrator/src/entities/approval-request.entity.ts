import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { ApprovalStatus } from "../domain/approval";
import type { PolicyActionType } from "../domain/policy";

/**
 * M4-S4: one durable ApprovalRequest per intercepted action (proposalId is
 * unique — approval replay returns the same outcome and never re-executes).
 * Transitions PENDING → APPROVED | DENIED | EXPIRED are exactly-once under
 * row locks; approving resumes the SAME attempt (same invocationId).
 */
@Entity("approval_requests")
@Unique("UQ_approval_request_proposal", ["proposalId"])
@Index("IDX_approval_request_status_expiry", ["status", "expiresAt"])
export class ApprovalRequestEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 64 })
  proposalId: string;

  @Column({ type: "char", length: 64 })
  proposalHash: string;

  @Column({ type: "varchar", length: 32 })
  actionType: PolicyActionType;

  @Column({ type: "varchar", length: 255 })
  executionId: string;

  @Column({ type: "varchar", length: 255 })
  logicalStepId: string;

  @Column({ type: "int" })
  attemptNumber: number;

  @Column({ type: "varchar", length: 255, nullable: true })
  targetAgent: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  targetExecutor: string | null;

  @Column({ type: "varchar", length: 16 })
  status: ApprovalStatus;

  @Column({ type: "timestamp" })
  expiresAt: Date;

  @Column({ type: "timestamp", nullable: true })
  decidedAt: Date | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  decisionNote: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
