import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Tenvyr-owned durable Artifact reference identity. One row per canonical
 * ResultInbox descriptor (result_inbox payload.artifacts[i]); the descriptor
 * itself stays in the canonical inbox payload — this table is only the stable
 * identity/provenance index. Records are insert-only: there is no update path.
 *
 * Referential deletion: deleting a ResultInbox row (never done by current
 * code — inbox rows are audit history) cascades to its Artifact index rows,
 * mirroring agent_events -> step_attempts ON DELETE CASCADE.
 *
 * The FK + CASCADE live in the M2 migration only (matching agent_events);
 * the disposable dev `synchronize` path therefore creates the table without
 * the FK. Keep it that way: entity relations here would diverge from the
 * migration DDL.
 */
@Entity("artifacts")
@Unique("UQ_artifact_inbox_ordinal", ["resultInboxId", "descriptorOrdinal"])
export class ArtifactEntity {
  /** Tenvyr-owned stable artifact identity (uuid v4). */
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Canonical ResultInbox row; resolves producer lineage to one StepAttempt. */
  @Column({ type: "uuid" })
  resultInboxId: string;

  /** Index of the descriptor within the canonical result.artifacts array. */
  @Column({ type: "integer" })
  descriptorOrdinal: number;

  /** SHA-256 of the canonical descriptor JSON (worker id is NOT global). */
  @Column({ type: "varchar", length: 64 })
  descriptorHash: string;

  @CreateDateColumn()
  createdAt: Date;
}
