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
  CoordinationConfigV1,
  CoordinationPhase,
} from "../domain/coordination";
import type {
  AcceptanceEvidenceV1,
  WorkspaceSnapshotV1,
} from "../domain/workspace";

/**
 * M9-S2: one-to-one authority extension of an Execution. Freezes team
 * configuration and hard limits, phase, current iteration number, cumulative
 * worker count, loop deadline, active iteration, and version. It is not a
 * second Execution or user-facing workflow resource.
 */
@Entity("coordination_runs")
@Unique("UQ_coordination_run_execution", ["executionId"])
@Index("IDX_coordination_run_phase", ["phase"])
export class CoordinationRunEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  executionId: string;

  /** Frozen CoordinationConfigV1 (hard bounds cannot be raised). */
  @Column({ type: "jsonb" })
  config: CoordinationConfigV1;

  /** FROZEN workspace snapshot the run executed against (Product Phase 1);
   *  null for runs without a workspace. Best-effort repository identity —
   *  execution runs against the mutable local working tree (no snapshot
   *  isolation claim). */
  @Column({ type: "jsonb", nullable: true })
  workspace: WorkspaceSnapshotV1 | null;

  /** Optional operator-declared acceptance evidence (run metadata only —
   *  never executed by the orchestrator). */
  @Column({ type: "jsonb", nullable: true })
  acceptanceEvidence: AcceptanceEvidenceV1 | null;

  @Column({ type: "varchar", length: 50, default: "PLANNING" })
  phase: CoordinationPhase;

  @Column({ type: "integer", default: 0 })
  currentIterationNumber: number;

  @Column({ type: "integer", default: 0 })
  cumulativeWorkers: number;

  @Column({ type: "timestamp" })
  loopDeadlineAt: Date;

  @Column({ type: "uuid", nullable: true })
  activeIterationId: string;

  @Column({ type: "text", nullable: true })
  waitReason: string;

  /** Guarded optimistic/phase-update version. */
  @Column({ type: "integer", default: 1 })
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
