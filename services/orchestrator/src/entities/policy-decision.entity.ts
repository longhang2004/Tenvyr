import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { PolicyActionType, PolicyEffect } from "../domain/policy";

/**
 * M4-S3: append-only policy decision evidence. Every interception stores
 * the proposal hash, the bounded facts the decision was based on, the
 * frozen policy version/hash, the effect, reasons, and timestamps. An
 * ALLOW decision without a successful required reservation grants no
 * authority — the dispatch boundary reserves AFTER the decision.
 */
@Entity("policy_decisions")
@Index("IDX_policy_decision_scope", ["executionId", "logicalStepId"])
@Index("IDX_policy_decision_proposal", ["proposalId"])
export class PolicyDecisionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Stable action identity (e.g. attempt invocation id). */
  @Column({ type: "varchar", length: 64 })
  proposalId: string;

  @Column({ type: "varchar", length: 32 })
  actionType: PolicyActionType;

  @Column({ type: "varchar", length: 255 })
  executionId: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  logicalStepId: string | null;

  @Column({ type: "int", nullable: true })
  attemptNumber: number | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  targetAgent: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  targetExecutor: string | null;

  @Column({ type: "char", length: 64 })
  proposalHash: string;

  @Column({ type: "int" })
  policyVersion: number;

  @Column({ type: "char", length: 64 })
  policyHash: string;

  @Column({ type: "varchar", length: 16 })
  effect: PolicyEffect;

  @Column({ type: "jsonb" })
  reasons: string[];

  @CreateDateColumn()
  createdAt: Date;
}
