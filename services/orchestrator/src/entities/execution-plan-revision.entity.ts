import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { PipelineStepConfig } from "../domain/pipeline-definition";

@Entity("execution_plan_revisions")
@Unique("UQ_execution_plan_revision_number", ["executionId", "revisionNumber"])
@Index("IDX_execution_plan_revision_hash", ["executionId", "planHash"])
export class ExecutionPlanRevisionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  executionId: string;

  @Column({ type: "integer" })
  revisionNumber: number;

  @Column({ type: "uuid", nullable: true })
  parentRevisionId: string;

  @Column({ type: "integer", nullable: true })
  baseRevision: number;

  @Column({ type: "jsonb" })
  plan: { schemaVersion: 1; steps: PipelineStepConfig[] };

  @Column({ type: "varchar", length: 64, nullable: true })
  planHash: string;

  @Column({ type: "varchar", length: 50, default: "pipeline" })
  source: string;

  @Column({ type: "text", nullable: true })
  reason: string;

  @Column({ type: "jsonb", nullable: true })
  validationResult: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
