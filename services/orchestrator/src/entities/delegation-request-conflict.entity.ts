import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/** Append-only evidence for a reused supervised-delegation identity whose
 * payload differs from the canonical request. It never creates authority. */
@Entity("delegation_request_conflicts")
@Index("IDX_delegation_request_conflict_identity", [
  "parentAttemptId",
  "requestId",
  "receivedAt",
  "id",
])
export class DelegationRequestConflictEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  parentAttemptId: string;

  @Column({ type: "varchar", length: 255 })
  requestId: string;

  @Column({ type: "char", length: 64 })
  payloadHash: string;

  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  @Column({ type: "varchar", length: 32 })
  conflictKind: "PAYLOAD_MISMATCH" | "LEGACY_PAYLOAD_UNKNOWN";

  @CreateDateColumn()
  receivedAt: Date;
}
