import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { AgentDelegationObservationV1 } from "@tenvyr/contracts";

export type DelegationObservationConflictKind = "identity_payload";

/**
 * M6-S1: retained evidence when the SAME (stepAttemptId, observationId)
 * arrives with a DIFFERENT payload hash. The canonical observation row
 * stays authoritative; the conflicting delivery is auditable evidence.
 */
@Entity("delegation_observation_conflicts")
@Index("IDX_delegation_observation_conflict_attempt", [
  "stepAttemptId",
  "receivedAt",
  "id",
])
export class DelegationObservationConflictEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @Column({ type: "uuid" })
  executionId: string;

  @Column({ type: "varchar", length: 320 })
  observationId: string;

  @Column({ type: "varchar", length: 64 })
  payloadHash: string;

  @Column({ type: "jsonb" })
  payload: AgentDelegationObservationV1;

  @Column({ type: "varchar", length: 32 })
  conflictKind: DelegationObservationConflictKind;

  @CreateDateColumn()
  receivedAt: Date;
}
