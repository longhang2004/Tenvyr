import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { WorkspaceSnapshotV1 } from "../domain/workspace";

/**
 * Product Phase 1: stable Workspace identity. Stores the operator-selected
 * local path plus the last captured repository identity snapshot. Team runs
 * freeze their own copy of the snapshot (CoordinationRunEntity.workspace);
 * this row is the stable identifier + refreshable identity record.
 */
@Entity("workspaces")
export class WorkspaceEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Operator-declared stable name (bounded). */
  @Column({ type: "varchar", length: 255 })
  name: string;

  /** Absolute local path the workspace resolves to. */
  @Column({ type: "varchar", length: 4096 })
  path: string;

  /** Last captured repository identity snapshot (bounded; nullable
   *  repository fields are valid for non-git directories). */
  @Column({ type: "jsonb" })
  snapshot: WorkspaceSnapshotV1;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
