import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { StepAttemptEntity } from "./step-attempt.entity";

export type AgentEventConflictKind = "event_id_payload" | "sequence_owner";

/**
 * Safe evidence for a rejected AgentEvent: same eventId with a different
 * canonical payload, or a different eventId claiming an owned sequence.
 * Canonical rows in agent_events are never overwritten.
 */
@Entity("agent_event_conflicts")
@Index("IDX_agent_event_conflict_attempt_received", [
  "stepAttemptId",
  "receivedAt",
])
export class AgentEventConflictEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @ManyToOne(() => StepAttemptEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "stepAttemptId" })
  attempt: StepAttemptEntity;

  @Column({ type: "varchar", length: 255 })
  invocationId: string;

  @Column({ type: "varchar", length: 255 })
  eventId: string;

  @Column({ type: "integer" })
  sequence: number;

  @Column({ type: "varchar", length: 50 })
  conflictKind: AgentEventConflictKind;

  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  @Column({ type: "jsonb", nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: "varchar", length: 50 })
  sourceAdapter: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceScope: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  sourceMessageId: string | null;

  @Column({ type: "timestamp" })
  receivedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
