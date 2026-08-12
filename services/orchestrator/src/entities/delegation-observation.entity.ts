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
import type { AgentDelegationObservationV1 } from "@tenvyr/contracts";
import { StepAttemptEntity } from "./step-attempt.entity";

/**
 * M6-S1: durable OBSERVED-mode delegation evidence for one StepAttempt.
 * Never authoritative lifecycle state: observations never schedule,
 * spend, cancel, or terminalize work — they are inert, bounded,
 * hash-pinned evidence. Canonical identity is (stepAttemptId,
 * observationId) where observationId = `${provider}:${childId}`; the
 * payload hash is part of the row so hash mismatches are retained in
 * DelegationObservationConflictEntity.
 */
@Entity("delegation_observations")
@Unique("UQ_delegation_observation_identity", [
  "stepAttemptId",
  "observationId",
])
@Index("IDX_delegation_observation_attempt", [
  "stepAttemptId",
  "receivedAt",
  "id",
])
export class DelegationObservationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @ManyToOne(() => StepAttemptEntity, { onDelete: "NO ACTION" })
  @JoinColumn({ name: "stepAttemptId" })
  attempt: StepAttemptEntity;

  @Column({ type: "varchar", length: 255 })
  invocationId: string;

  @Column({ type: "uuid" })
  executionId: string;

  /** `${provider}:${childId}` — the runtime-asserted identity. */
  @Column({ type: "varchar", length: 320 })
  observationId: string;

  @Column({ type: "varchar", length: 64 })
  provider: string;

  @Column({ type: "varchar", length: 255 })
  childId: string;

  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  @Column({ type: "jsonb" })
  payload: AgentDelegationObservationV1;

  @Column({ type: "timestamp" })
  occurredAt: Date;

  @CreateDateColumn()
  receivedAt: Date;
}
