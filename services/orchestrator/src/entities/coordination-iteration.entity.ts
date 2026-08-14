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
  TaskBatchProposalV1,
  VerifierDecisionV1,
} from "../domain/coordination";

export type WorkerManifestEntryV1 = {
  taskId: string;
  /** LogicalStep ID in the parent Execution DAG (never duplicated work). */
  logicalStepId: string;
  required: boolean;
};

/**
 * M9-S2: stable iteration identity. Unique (run, number); frozen Planner
 * proposal; accepted plan revision; bounded worker manifest referencing
 * LogicalStep IDs; Verifier step/attempt; immutable consumed decision +
 * canonical hash; terminal iteration outcome. Worker work itself is never
 * duplicated here — the manifest references existing LogicalSteps.
 */
@Entity("coordination_iterations")
@Unique("UQ_coordination_iteration_number", ["coordinationRunId", "iterationNumber"])
@Index("IDX_coordination_iteration_run_number", ["coordinationRunId", "iterationNumber"])
export class CoordinationIterationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  coordinationRunId: string;

  @Column({ type: "integer" })
  iterationNumber: number;

  /** Planner StepAttempt id (set when the Planner step is claimed). */
  @Column({ type: "uuid", nullable: true })
  plannerAttemptId: string;

  /** Planner logical step id (Coordinator-owned, one per iteration). */
  @Column({ type: "varchar", length: 100, nullable: true })
  plannerStepId: string;

  /** Frozen TaskBatchProposalV1 (untrusted Planner output, validated). */
  @Column({ type: "jsonb", nullable: true })
  plannerProposal: TaskBatchProposalV1;

  /** Accepted immutable plan revision id. */
  @Column({ type: "uuid", nullable: true })
  acceptedPlanRevisionId: string;

  /** M9-S7: durable PlanPatch proposal id awaiting approval for this
   *  iteration (policy REQUIRE_APPROVAL intercept). Approval resumes and
   *  binds THIS proposal exactly once; reconciliation re-activates it
   *  instead of proposing anew (no proposal storms). Null when no
   *  activation is pending. */
  @Column({ type: "uuid", nullable: true })
  pendingPlanProposalId: string;

  /** Bounded worker manifest: LogicalStep references + required flags. */
  @Column({ type: "jsonb", default: [] })
  workerManifest: WorkerManifestEntryV1[];

  /** LogicalStep id of the Tenvyr-owned Verifier step. */
  @Column({ type: "varchar", length: 100, nullable: true })
  verifierStepId: string;

  /** Verifier StepAttempt id; consumed at most once per run (unique). */
  @Column({ type: "uuid", nullable: true })
  verifierAttemptId: string;

  /** Immutable consumed VerifierDecisionV1. */
  @Column({ type: "jsonb", nullable: true })
  decision: VerifierDecisionV1;

  /** Canonical decision hash; set exactly once. */
  @Column({ type: "varchar", length: 64, nullable: true })
  decisionHash: string;

  /** Terminal iteration outcome ("CONTINUE" | "ACCEPT" | "FAIL" | ...). */
  @Column({ type: "varchar", length: 50, nullable: true })
  outcome: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
