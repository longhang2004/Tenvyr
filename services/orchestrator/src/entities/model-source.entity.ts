import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import type {
  ModelSourceKind,
  ModelSourceReasonCode,
  ModelSourceStatusState,
} from "../executors/model-source";

/**
 * P2: authoritative Model Source rows (operator configuration only).
 *
 * Credentials are REFERENCES only (`credentialEnvRef` = environment
 * variable NAME); values never enter the row. Catalogs are NOT stored here
 * or anywhere — they are bounded on-demand projections. `modelCount` is
 * bounded projection metadata of the last refresh, never authority.
 */
@Entity("model_sources")
@Unique("UQ_model_source_id", ["sourceId"])
@Index("IDX_model_source_kind", ["kind"])
export class ModelSourceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Stable operator identity ("src:generic-endpoint"). */
  @Column({ type: "varchar", length: 128 })
  sourceId: string;

  @Column({ type: "varchar", length: 50 })
  kind: ModelSourceKind;

  @Column({ type: "varchar", length: 255 })
  displayName: string;

  /** http/https endpoint without userinfo (validated in the domain). */
  @Column({ type: "varchar", length: 2048, nullable: true })
  baseUrl: string;

  /** Environment variable NAME reference — never a value. */
  @Column({ type: "varchar", length: 255, nullable: true })
  credentialEnvRef: string;

  @Column({ type: "varchar", length: 50, default: "UNKNOWN" })
  statusState: ModelSourceStatusState;

  @Column({ type: "varchar", length: 50, default: "none" })
  statusReasonCode: ModelSourceReasonCode;

  @Column({ type: "timestamp", nullable: true })
  statusTestedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastCatalogRefreshAt: Date;

  /** Bounded model count of the last catalog snapshot (0 = never). */
  @Column({ type: "integer", default: 0 })
  modelCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
