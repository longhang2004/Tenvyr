import { DataSource } from 'typeorm';
import { PipelineEntity } from '../entities/pipeline.entity';
import { ExecutionEntity } from '../entities/execution.entity';
import { StepExecutionEntity } from '../entities/step-execution.entity';

export const repositoryProviders = [
  {
    provide: 'PIPELINE_REPOSITORY',
    useFactory: (dataSource: DataSource) => dataSource.getRepository(PipelineEntity),
    inject: ['DATA_SOURCE'],
  },
  {
    provide: 'EXECUTION_REPOSITORY',
    useFactory: (dataSource: DataSource) => dataSource.getRepository(ExecutionEntity),
    inject: ['DATA_SOURCE'],
  },
  {
    provide: 'STEP_EXECUTION_REPOSITORY',
    useFactory: (dataSource: DataSource) => dataSource.getRepository(StepExecutionEntity),
    inject: ['DATA_SOURCE'],
  },
];
