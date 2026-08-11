import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * M2E append-only controlled state-write provenance. One row per canonical
 * successful result that has configured `stateWrites`, recording the
 * disposition (`applied` | `noop` | `rejected`), prior and resulting semantic
 * state versions, the canonical mapping/patch hash when materialization
 * succeeded, and a stable rejection code when it failed.
 *
 * This is mutation provenance, not a complete replayable state history: the
 * canonical result output plus the frozen step configuration remain source
 * evidence, and full prior/new state copies are never stored here.
 *
 * Unique `resultInboxId` makes duplicate delivery unable to create a second
 * row. Foreign keys use NO ACTION: referenced evidence is never silently
 * cascade-deleted.
 */
@Entity("state_write_evidence")
@Unique("UQ_state_write_evidence_inbox", ["resultInboxId"])
@Index("IDX_state_write_evidence_attempt", ["stepAttemptId"])
@Index("IDX_state_write_evidence_execution", ["executionId"])
export class StateWriteEvidenceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  executionId: string;

  @Column({ type: "uuid" })
  stepAttemptId: string;

  @Column({ type: "uuid" })
  resultInboxId: string;

  /** semantic ExecutionState version before this result's write. */
  @Column({ type: "integer" })
  priorVersion: number;

  /** semantic ExecutionState version after this result's write (same on no-op/reject). */
  @Column({ type: "integer" })
  resultVersion: number;

  @Column({ type: "varchar", length: 16 })
  disposition: "applied" | "noop" | "rejected";

  /** canonical mapping/patch hash when materialization succeeded. */
  @Column({ type: "varchar", length: 64, nullable: true })
  mappingHash: string | null;

  /** stable rejection code when materialization failed. */
  @Column({ type: "varchar", length: 64, nullable: true })
  rejectionCode: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
