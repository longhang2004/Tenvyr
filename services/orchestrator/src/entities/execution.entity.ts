import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
} from "typeorm";

export type ExecutionStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

@Entity("executions")
@Index("IDX_executions_pipeline_status", ["pipelineId", "status"])
export class ExecutionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  pipelineId: string;

  @Column({
    type: "varchar",
    length: 50,
    default: "PENDING",
  })
  status: ExecutionStatus;

  @Column({ type: "jsonb" })
  input: any; // Input parameters for this run

  @Column({ type: "varchar", length: 50, nullable: true })
  pipelineVersion: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  pipelineHash: string;

  @Column({ type: "jsonb", nullable: true })
  configurationSnapshot: Record<string, unknown>;

  @Column({ type: "uuid", nullable: true })
  activePlanRevisionId: string;

  @Column({ type: "text", nullable: true })
  terminationReason: string;

  @Column({ type: "jsonb", nullable: true })
  output: any; // Final output data

  // M2B: durable semantic ExecutionState. executionStateVersion is the
  // explicit semantic state version, incremented once per real mutation;
  // rowVersion above still guards the entire database row and is NOT the
  // semantic version. executionStateUpdatedAt stays null until the first
  // real mutation (no-ops never touch it).
  @Column({ type: "jsonb", default: {} })
  executionState: Record<string, unknown>;

  @Column({ type: "integer", default: 0 })
  executionStateVersion: number;

  @Column({ type: "timestamp", nullable: true })
  executionStateUpdatedAt: Date | null;

  @Column({ type: "timestamp", nullable: true })
  startTime: Date;

  @Column({ type: "timestamp", nullable: true })
  endTime: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @VersionColumn()
  rowVersion: number;
}
