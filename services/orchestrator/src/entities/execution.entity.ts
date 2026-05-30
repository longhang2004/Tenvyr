import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

@Entity('executions')
@Index('IDX_executions_pipeline_status', ['pipelineId', 'status'])
export class ExecutionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  pipelineId: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: 'PENDING',
  })
  status: ExecutionStatus;

  @Column({ type: 'jsonb' })
  input: any; // Input parameters for this run

  @Column({ type: 'jsonb', nullable: true })
  output: any; // Final output data

  @Column({ type: 'timestamp', nullable: true })
  startTime: Date;

  @Column({ type: 'timestamp', nullable: true })
  endTime: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
