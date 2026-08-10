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
import type { AgentEventType } from "@tenvyr/contracts";
import { StepAttemptEntity } from "./step-attempt.entity";

/**
 * Durable operational evidence for one StepAttempt. Never authoritative
 * lifecycle state: AgentResult remains the only worker-originated terminal
 * authority. Canonical event identity is (stepAttemptId, eventId); sequence is
 * the worker-produced logical order. Both are unique per attempt, so
 * duplicates are idempotent and conflicts are retained in
 * AgentEventConflictEntity.
 */
@Entity("agent_events")
@Unique("UQ_agent_event_identity", ["stepAttemptId", "eventId"])
@Unique("UQ_agent_event_sequence", ["stepAttemptId", "sequence"])
@Index("IDX_agent_event_execution_received", ["executionId", "receivedAt", "id"])
@Index("IDX_agent_event_attempt_received", ["stepAttemptId", "receivedAt", "id"])
@Index("IDX_agent_event_heartbeat_lookup", ["stepAttemptId", "receivedAt"], {
  where: `"type" = 'heartbeat'`,
})
@Index(
  "UQ_agent_event_transport",
  ["sourceAdapter", "sourceScope", "sourceMessageId"],
  { unique: true, where: `"sourceMessageId" IS NOT NULL` },
)
export class AgentEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @ManyToOne(() => StepAttemptEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "stepAttemptId" })
  attempt: StepAttemptEntity;

  @Column({ type: "varchar", length: 255 })
  invocationId: string;

  @Column({ type: "uuid" })
  executionId: string;

  @Column({ type: "uuid" })
  logicalStepId: string;

  @Column({ type: "varchar", length: 255 })
  eventId: string;

  @Column({ type: "integer" })
  sequence: number;

  @Column({ type: "varchar", length: 50 })
  type: AgentEventType;

  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: "jsonb" })
  trace: { traceId: string; correlationId: string };

  /** sha256 of the canonical validated event payload (identity evidence). */
  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  /** Worker-reported event time; audit evidence only, never a liveness clock. */
  @Column({ type: "timestamp" })
  occurredAt: Date;

  /** Tenvyr ingestion time; the liveness authority for supervision. */
  @Column({ type: "timestamp" })
  receivedAt: Date;

  @Column({ type: "varchar", length: 50 })
  sourceAdapter: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceScope: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceMessageId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
