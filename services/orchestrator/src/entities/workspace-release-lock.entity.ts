import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("workspace_release_locks")
export class WorkspaceReleaseLockEntity {
  @PrimaryColumn({ type: "varchar", length: 36 })
  workspaceExecutionId: string;

  @Column({ type: "varchar", length: 36 })
  releaseOperationId: string;

  @Column({ type: "timestamp", default: () => "now()" })
  createdAt: Date;
}
