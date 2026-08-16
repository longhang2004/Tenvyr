import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

export type StepAttemptStatus =
  | "CREATED"
  | "DISPATCHED"
  | "RUNNING"
  | "WAITING"
  | "SUCCESS"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

@Entity("step_attempts")
@Unique("UQ_step_attempt_number", ["logicalStepId", "attemptNumber"])
@Index("UQ_step_attempt_invocation", ["invocationId"], { unique: true })
@Index("UQ_step_attempt_active", ["logicalStepId"], {
  unique: true,
  where: `"status" IN ('CREATED', 'DISPATCHED', 'RUNNING')`,
})
@Index("IDX_step_attempt_status_deadline", ["status", "deadlineAt"])
export class StepAttemptEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  executionId: string;

  @Column({ type: "uuid" })
  logicalStepId: string;

  @Column({ type: "uuid" })
  planRevisionId: string;

  @Column({ type: "integer" })
  attemptNumber: number;

  @Column({ type: "varchar", length: 255 })
  invocationId: string;

  @Column({ type: "varchar", length: 64 })
  frozenSpecHash: string;

  @Column({ type: "jsonb", nullable: true })
  inputSnapshot: unknown;

  @Column({ type: "jsonb", nullable: true })
  contextSnapshot: unknown;

  /** P3: immutable bounded InvocationEfficiencyEvidenceV1 for the attempt's
   *  runtime invocation (ContextBundle identity/reuse, frozen harness,
   *  workspace identity, context metrics, session mode, reported usage,
   *  timing). Written once at claim, completed once at result acceptance.
   *  Telemetry-safe by construction: hashes/sizes/counts/ids only. */
  @Column({ type: "jsonb", nullable: true })
  efficiency: unknown;

  @Column({ type: "jsonb" })
  executorSnapshot: Record<string, unknown>;

  @Column({ type: "varchar", length: 50, default: "CREATED" })
  status: StepAttemptStatus;

  @Column({ type: "timestamp", nullable: true })
  dispatchedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  startTime: Date;

  @Column({ type: "timestamp", nullable: true })
  deadlineAt: Date;

  @Column({ type: "timestamp", nullable: true })
  terminalAt: Date;

  /** Server-received liveness projection; only updated while non-terminal. */
  @Column({ type: "timestamp", nullable: true })
  acceptedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastEventReceivedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastHeartbeatReceivedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastProgressReceivedAt: Date;

  @Column({ type: "jsonb", nullable: true })
  result: unknown;

  @Column({ type: "text", nullable: true })
  error: string;

  @Column({ type: "text", nullable: true })
  terminationReason: string;

  @CreateDateColumn()
  createdAt: Date;
}
