import { Injectable, Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ExecutionEntity, ExecutionStatus } from '../entities/execution.entity';
import { StepExecutionEntity, StepStatus } from '../entities/step-execution.entity';

@Injectable()
export class ExecutionService {
  constructor(
    @Inject('EXECUTION_REPOSITORY')
    private executionRepository: Repository<ExecutionEntity>,
    @Inject('STEP_EXECUTION_REPOSITORY')
    private stepExecutionRepository: Repository<StepExecutionEntity>,
  ) {}

  async createExecution(pipelineId: string, input: any): Promise<ExecutionEntity> {
    const execution = this.executionRepository.create({
      pipelineId,
      status: 'PENDING',
      input,
      startTime: new Date(),
    });
    return this.executionRepository.save(execution);
  }

  async updateExecutionStatus(id: string, status: ExecutionStatus, output?: any): Promise<ExecutionEntity> {
    const updateData: Partial<ExecutionEntity> = { status };
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
      updateData.endTime = new Date();
    }
    if (output !== undefined) {
      updateData.output = output;
    }
    await this.executionRepository.update(id, updateData);
    return this.executionRepository.findOne({
      where: { id },
    }) as Promise<ExecutionEntity>;
  }

  async getExecution(id: string): Promise<ExecutionEntity | null> {
    return this.executionRepository.findOne({ where: { id } });
  }

  async listExecutions(): Promise<ExecutionEntity[]> {
    return this.executionRepository.find({ order: { createdAt: 'DESC' } });
  }

  async createStepExecution(
    executionId: string,
    stepId: string,
    agent: string,
    input: any,
    maxAttempts = 1,
  ): Promise<StepExecutionEntity> {
    let stepExecution = await this.stepExecutionRepository.findOne({
      where: { executionId, stepId },
    });

    if (stepExecution) {
      stepExecution.agent = agent;
      stepExecution.input = input;
      stepExecution.status = 'PENDING';
      stepExecution.output = null;
      stepExecution.error = null;
      stepExecution.startTime = null;
      stepExecution.endTime = null;
      stepExecution.attempt = (stepExecution.attempt || 0) + 1;
      stepExecution.maxAttempts = maxAttempts;
    } else {
      stepExecution = this.stepExecutionRepository.create({
        executionId,
        stepId,
        agent,
        status: 'PENDING',
        input,
        attempt: 1,
        maxAttempts,
      });
    }

    return this.stepExecutionRepository.save(stepExecution);
  }

  async updateStepStatus(
    executionId: string,
    stepId: string,
    status: StepStatus,
    output?: any,
    error?: string,
  ): Promise<StepExecutionEntity> {
    const step = await this.stepExecutionRepository.findOne({
      where: { executionId, stepId },
    });
    if (!step) {
      throw new Error(`Step execution not found for run ${executionId} and step ${stepId}`);
    }

    step.status = status;
    if (status === 'RUNNING' && !step.startTime) {
      step.startTime = new Date();
    }
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'SKIPPED') {
      step.endTime = new Date();
    }
    if (output !== undefined) {
      step.output = output;
    }
    if (error !== undefined) {
      step.error = error;
    }
    return this.stepExecutionRepository.save(step);
  }

  async getStepExecutions(executionId: string): Promise<StepExecutionEntity[]> {
    return this.stepExecutionRepository.find({
      where: { executionId },
      order: { createdAt: 'ASC' },
    });
  }

  async getStepExecution(executionId: string, stepId: string): Promise<StepExecutionEntity | null> {
    return this.stepExecutionRepository.findOne({
      where: { executionId, stepId },
    });
  }

  async getStepExecutionById(id: string): Promise<StepExecutionEntity | null> {
    return this.stepExecutionRepository.findOne({ where: { id } });
  }
}
