import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export type StepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

@Entity('step_executions')
@Unique('UQ_step_executions_execution_step', ['executionId', 'stepId'])
@Index('IDX_step_executions_execution_status', ['executionId', 'status'])
export class StepExecutionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  executionId: string;

  @Column({ type: 'varchar', length: 100 })
  stepId: string; // The step ID in the DAG (e.g. 'review', 'observe')

  @Column({ type: 'varchar', length: 100 })
  agent: string; // The agent execution target (e.g. 'code-reviewer')

  @Column({
    type: 'varchar',
    length: 50,
    default: 'PENDING',
  })
  status: StepStatus;

  @Column({ type: 'jsonb', nullable: true })
  input: any; // Context/inputs injected for this step

  @Column({ type: 'jsonb', nullable: true })
  output: any; // Output result from the agent execution

  @Column({ type: 'text', nullable: true })
  error: string; // Failure/error message if FAILED

  @Column({ type: 'integer', default: 0 })
  attempt: number;

  @Column({ type: 'integer', default: 0 })
  maxAttempts: number;

  @Column({ type: 'timestamp', nullable: true })
  startTime: Date;

  @Column({ type: 'timestamp', nullable: true })
  endTime: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
