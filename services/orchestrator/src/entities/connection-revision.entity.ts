import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type {
  ConnectionCapabilities,
  ConnectionProfileV1,
} from "../executors/runtime-connection";

/**
 * Immutable secret-free connection revision. No code path updates or deletes
 * these rows: the database trigger `TRG_connection_revision_immutable`
 * enforces the property durably, and `currentRevisionNumber` on the
 * connection row advances only by appending.
 */
@Entity("connection_revisions")
@Unique("UQ_connection_revision_number", ["connectionId", "revisionNumber"])
@Index("IDX_connection_revision_connection", ["connectionId", "revisionNumber"])
export class ConnectionRevisionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  connectionId: string;

  @Column({ type: "integer" })
  revisionNumber: number;

  /** Secret-free operator profile (credential fields are env references). */
  @Column({ type: "jsonb" })
  profile: ConnectionProfileV1;

  /** SHA-256 (hex) of the canonical secret-free profile. */
  @Column({ type: "varchar", length: 64 })
  configHash: string;

  /** Conservative capabilities resolved at freeze time. */
  @Column({ type: "jsonb" })
  capabilities: ConnectionCapabilities;

  /** Row insertion time == revision freeze time. */
  @CreateDateColumn()
  createdAt: Date;
}
