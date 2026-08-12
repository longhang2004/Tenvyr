import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { PlanPatchV1 } from "../domain/plan-patch";

export type PlanProposalStatus =
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "STALE";

/**
 * M5-S2: an immutable PlanPatch proposal and its TERMINAL decision.
 * Proposals are numbered per execution, hash-pinned, and never mutated
 * after the activating transaction decides them (ACCEPTED/REJECTED/STALE).
 * A crash mid-activation leaves the proposal PENDING so activation is
 * retryable; a committed decision is final.
 */
@Entity("plan_proposals")
@Unique("UQ_plan_proposal_number", ["executionId", "proposalNumber"])
@Index("IDX_plan_proposal_execution_status", ["executionId", "status"])
export class PlanProposalEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  executionId: string;

  @Column({ type: "integer" })
  proposalNumber: number;

  /** The revision number the proposal builds on (CAS input). */
  @Column({ type: "integer" })
  baseRevision: number;

  @Column({ type: "jsonb" })
  proposal: PlanPatchV1;

  @Column({ type: "varchar", length: 64 })
  proposalHash: string;

  @Column({ type: "varchar", length: 20, default: "PENDING" })
  status: PlanProposalStatus;

  @Column({ type: "text", nullable: true })
  decisionReason: string;

  @Column({ type: "varchar", length: 50, default: "operator" })
  source: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamp", nullable: true })
  decidedAt: Date | null;
}
