import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import type { PipelineStepConfig } from "../domain/pipeline-definition";

@Entity("pipelines")
@Index("IDX_pipelines_name_version", ["name", "version"])
export class PipelineEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "varchar", length: 50 })
  version: string;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({ type: "jsonb" })
  steps: PipelineStepConfig[];

  @Column({ type: "integer", default: 1 })
  schemaVersion: number;

  @Column({ type: "varchar", length: 64, nullable: true })
  contentHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
