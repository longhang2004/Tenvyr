import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { ExecutionService } from './execution.service';
import { KafkaService } from './kafka.service';
import { ExecutionEntity } from '../entities/execution.entity';
import { StepExecutionEntity, StepStatus } from '../entities/step-execution.entity';

type FailurePolicy = 'continue' | 'stop' | 'retry';

type PipelineStepConfig = {
  id: string;
  agent: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  condition?: string;
  timeout?: string | number;
  retries?: number;
  onFailure?: FailurePolicy;
};

type TemplateContext = {
  pipeline: {
    input: unknown;
  };
  steps: Record<
    string,
    {
      result: unknown;
      output: unknown;
      status: StepStatus;
      error?: string;
      attempt?: number;
    }
  >;
};

const TERMINAL_STEP_STATUSES: StepStatus[] = ['COMPLETED', 'FAILED', 'SKIPPED'];

@Injectable()
export class EngineService {
  constructor(
    private pipelineService: PipelineService,
    private executionService: ExecutionService,
    @Inject(forwardRef(() => KafkaService))
    private kafkaService: KafkaService,
  ) {}

  async startExecution(pipelineId: string, input: unknown): Promise<ExecutionEntity> {
    const pipeline = await this.pipelineService.findOne(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline with ID ${pipelineId} not found.`);
    }

    const execution = await this.executionService.createExecution(pipelineId, input);
    const runningExecution = await this.executionService.updateExecutionStatus(execution.id, 'RUNNING');

    console.log(`Starting execution [${execution.id}] for pipeline [${pipeline.name}]`);
    await this.notifyGatewayUpdate(execution.id);

    const steps = pipeline.steps as PipelineStepConfig[];
    const initialSteps = steps.filter((step) => !step.dependsOn || step.dependsOn.length === 0);

    if (initialSteps.length === 0) {
      return this.failExecution(execution.id, {
        error: 'No initial steps found without dependencies.',
      });
    }

    for (const step of initialSteps) {
      const shouldExecute = await this.evaluateStepCondition(runningExecution, [], step);
      if (shouldExecute) {
        await this.triggerStep(runningExecution, step);
      } else {
        await this.skipStep(runningExecution, step);
      }
    }

    return (await this.executionService.getExecution(execution.id)) ?? runningExecution;
  }

  async handleStepCompletion(
    executionId: string,
    stepId: string,
    status: StepStatus,
    output?: unknown,
    error?: string,
    attempt?: number,
  ) {
    console.log(`Step [${stepId}] in execution [${executionId}] completed with status [${status}]`);

    const currentStep = await this.executionService.getStepExecution(executionId, stepId);
    if (!currentStep) {
      console.warn(`Ignoring result for unknown step [${stepId}] in execution [${executionId}]`);
      return;
    }

    if (attempt !== undefined && currentStep.attempt !== attempt) {
      console.warn(
        `Ignoring stale result for step [${stepId}] in execution [${executionId}]. Received attempt ${attempt}, current attempt ${currentStep.attempt}.`,
      );
      return;
    }

    if (TERMINAL_STEP_STATUSES.includes(currentStep.status)) {
      console.warn(`Ignoring duplicate terminal update for step [${stepId}] in execution [${executionId}]`);
      return;
    }

    await this.executionService.updateStepStatus(executionId, stepId, status, output, error);
    await this.notifyGatewayUpdate(executionId);

    const execution = await this.executionService.getExecution(executionId);
    if (!execution || execution.status !== 'RUNNING') return;

    const pipeline = await this.pipelineService.findOne(execution.pipelineId);
    if (!pipeline) return;

    const steps = pipeline.steps as PipelineStepConfig[];
    const stepConfig = steps.find((step) => step.id === stepId);

    if (status === 'FAILED') {
      const shouldContinue = await this.handleFailurePolicy(execution, stepConfig, error);
      if (!shouldContinue) return;
    }

    await this.processExecutionProgress(execution, steps, stepId);
  }

  private async handleFailurePolicy(
    execution: ExecutionEntity,
    stepConfig: PipelineStepConfig | undefined,
    error?: string,
  ): Promise<boolean> {
    if (!stepConfig) {
      await this.failExecution(execution.id, {
        error: error || 'Step execution failed and step configuration was not found.',
      });
      return false;
    }

    const policy = stepConfig.onFailure || 'stop';
    const currentStep = await this.executionService.getStepExecution(execution.id, stepConfig.id);
    const maxAttempts = this.getMaxAttempts(stepConfig);

    if (policy === 'retry' && currentStep && currentStep.attempt < maxAttempts) {
      console.log(
        `Retrying step [${stepConfig.id}] in execution [${execution.id}] after failed attempt ${currentStep.attempt}/${maxAttempts}`,
      );
      await this.triggerStep(execution, stepConfig, { force: true });
      return false;
    }

    if (policy === 'continue') {
      console.log(`Continuing execution [${execution.id}] after failed step [${stepConfig.id}]`);
      return true;
    }

    await this.failExecution(execution.id, {
      failedStep: stepConfig.id,
      error: error || 'Step execution failed.',
      attempts: currentStep?.attempt ?? 1,
      maxAttempts,
    });
    return false;
  }

  private async processExecutionProgress(
    execution: ExecutionEntity,
    steps: PipelineStepConfig[],
    completedStepId: string,
  ) {
    const stepExecutions = await this.executionService.getStepExecutions(execution.id);

    const allStepsCompleted = steps.every((stepConfig) => {
      const stepExecution = stepExecutions.find((step) => step.stepId === stepConfig.id);
      return stepExecution && TERMINAL_STEP_STATUSES.includes(stepExecution.status);
    });

    if (allStepsCompleted) {
      console.log(`All steps completed. Completing execution [${execution.id}]`);
      const outputs: Record<string, unknown> = {};
      for (const stepExecution of stepExecutions) {
        outputs[stepExecution.stepId] = stepExecution.output;
      }
      await this.executionService.updateExecutionStatus(execution.id, 'COMPLETED', outputs);
      await this.notifyGatewayUpdate(execution.id);
      return;
    }

    const nextSteps = steps.filter((step) => step.dependsOn?.includes(completedStepId));

    for (const nextStep of nextSteps) {
      const existingStep = await this.executionService.getStepExecution(execution.id, nextStep.id);
      if (existingStep) continue;

      const dependenciesResolved = nextStep.dependsOn?.every((dependencyId) => {
        const dependencyExecution = stepExecutions.find((step) => step.stepId === dependencyId);
        return this.isDependencyResolved(dependencyExecution, steps);
      });

      if (!dependenciesResolved) continue;

      const shouldExecute = await this.evaluateStepCondition(execution, stepExecutions, nextStep);
      if (shouldExecute) {
        await this.triggerStep(execution, nextStep);
      } else {
        console.log(`Step [${nextStep.id}] condition evaluated to false. Skipping step.`);
        await this.skipStep(execution, nextStep);
      }
    }
  }

  private async triggerStep(
    execution: ExecutionEntity,
    stepConfig: PipelineStepConfig,
    options: { force?: boolean } = {},
  ) {
    if (!options.force) {
      const existingStep = await this.executionService.getStepExecution(execution.id, stepConfig.id);
      if (existingStep) return;
    }

    console.log(`Triggering step [${stepConfig.id}] for agent [${stepConfig.agent}] in execution [${execution.id}]`);

    const maxAttempts = this.getMaxAttempts(stepConfig);
    let resolvedInput: unknown;

    try {
      const stepExecutions = await this.executionService.getStepExecutions(execution.id);
      resolvedInput = this.resolveInputTemplates(stepConfig.input || {}, execution.input, stepExecutions);
    } catch (err) {
      const message = this.getErrorMessage(err);
      const failedStep = await this.executionService.createStepExecution(
        execution.id,
        stepConfig.id,
        stepConfig.agent,
        null,
        maxAttempts,
      );
      await this.handleStepCompletion(
        execution.id,
        stepConfig.id,
        'FAILED',
        null,
        `Input resolution failed: ${message}`,
        failedStep.attempt,
      );
      return;
    }

    const stepExecution = await this.executionService.createStepExecution(
      execution.id,
      stepConfig.id,
      stepConfig.agent,
      resolvedInput,
      maxAttempts,
    );
    await this.executionService.updateStepStatus(execution.id, stepConfig.id, 'RUNNING');
    await this.notifyGatewayUpdate(execution.id);
    this.scheduleStepTimeout(execution.id, stepConfig, stepExecution.attempt);

    try {
      await this.kafkaService.sendTask(
        stepConfig.agent,
        execution.id,
        stepConfig.id,
        resolvedInput,
        stepExecution.attempt,
        maxAttempts,
        stepConfig.timeout,
      );
    } catch (err) {
      const message = this.getErrorMessage(err);
      await this.handleStepCompletion(execution.id, stepConfig.id, 'FAILED', null, `Kafka dispatch failed: ${message}`);
    }
  }

  private async skipStep(execution: ExecutionEntity, stepConfig: PipelineStepConfig) {
    await this.executionService.createStepExecution(execution.id, stepConfig.id, stepConfig.agent, null, 1);
    await this.executionService.updateStepStatus(execution.id, stepConfig.id, 'SKIPPED', null);
    await this.notifyGatewayUpdate(execution.id);
    const pipeline = await this.pipelineService.findOne(execution.pipelineId);
    if (pipeline) {
      await this.processExecutionProgress(execution, pipeline.steps as PipelineStepConfig[], stepConfig.id);
    }
  }

  private scheduleStepTimeout(executionId: string, stepConfig: PipelineStepConfig, attempt: number) {
    const timeoutMs = this.parseDurationMs(stepConfig.timeout);
    if (!timeoutMs) return;

    setTimeout(async () => {
      try {
        const execution = await this.executionService.getExecution(executionId);
        const stepExecution = await this.executionService.getStepExecution(executionId, stepConfig.id);
        if (!execution || execution.status !== 'RUNNING' || !stepExecution) return;
        if (stepExecution.status !== 'RUNNING' || stepExecution.attempt !== attempt) return;

        await this.handleStepCompletion(
          executionId,
          stepConfig.id,
          'FAILED',
          null,
          `Step timed out after ${stepConfig.timeout}`,
          attempt,
        );
      } catch (err) {
        console.error(`Failed while enforcing timeout for step [${stepConfig.id}]:`, this.getErrorMessage(err));
      }
    }, timeoutMs);
  }

  private isDependencyResolved(
    dependencyExecution: StepExecutionEntity | undefined,
    steps: PipelineStepConfig[],
  ): boolean {
    if (!dependencyExecution) return false;
    if (dependencyExecution.status === 'COMPLETED' || dependencyExecution.status === 'SKIPPED') return true;
    if (dependencyExecution.status !== 'FAILED') return false;

    const dependencyConfig = steps.find((step) => step.id === dependencyExecution.stepId);
    return dependencyConfig?.onFailure === 'continue';
  }

  private resolveInputTemplates(inputConfig: unknown, pipelineInput: unknown, stepExecutions: StepExecutionEntity[]): unknown {
    return this.resolveTemplateValue(inputConfig, this.buildTemplateContext(pipelineInput, stepExecutions));
  }

  private resolveTemplateValue(value: unknown, context: TemplateContext): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveTemplateValue(item, context));
    }

    if (value && typeof value === 'object') {
      const resolvedObject: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        resolvedObject[key] = this.resolveTemplateValue(nestedValue, context);
      }
      return resolvedObject;
    }

    if (typeof value !== 'string') return value;

    const exactMatch = value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
    if (exactMatch) {
      const resolvedValue = this.resolveTemplateExpression(exactMatch[1], context);
      return resolvedValue === undefined ? null : resolvedValue;
    }

    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expression: string) => {
      const resolvedValue = this.resolveTemplateExpression(expression, context);
      if (resolvedValue === undefined || resolvedValue === null) return '';
      if (typeof resolvedValue === 'string') return resolvedValue;
      return JSON.stringify(resolvedValue);
    });
  }

  private async evaluateStepCondition(
    execution: ExecutionEntity,
    stepExecutions: StepExecutionEntity[],
    stepConfig: PipelineStepConfig,
  ): Promise<boolean> {
    if (!stepConfig.condition) return true;

    try {
      const context = this.buildTemplateContext(execution.input, stepExecutions);
      const expression = this.unwrapConditionExpression(stepConfig.condition);
      const resolvedCondition = expression.replace(/\b(pipeline|steps)(?:\.[a-zA-Z0-9_-]+)+\b/g, (path: string) => {
        const resolvedValue = this.getValueFromPath(context, path.split('.'));
        return resolvedValue !== undefined ? JSON.stringify(resolvedValue) : 'undefined';
      });

      console.log(`Evaluating condition [${stepConfig.condition}] -> [${resolvedCondition}]`);

      const checkFn = new Function(`return (${resolvedCondition});`);
      return !!checkFn();
    } catch (err) {
      console.error(`Failed to evaluate condition [${stepConfig.condition}]:`, err);
      return false;
    }
  }

  private unwrapConditionExpression(condition: string): string {
    const match = condition.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
    return match ? match[1] : condition;
  }

  private buildTemplateContext(pipelineInput: unknown, stepExecutions: StepExecutionEntity[]): TemplateContext {
    const steps: TemplateContext['steps'] = {};

    for (const stepExecution of stepExecutions) {
      steps[stepExecution.stepId] = {
        result: stepExecution.output,
        output: stepExecution.output,
        status: stepExecution.status,
        error: stepExecution.error,
        attempt: stepExecution.attempt,
      };
    }

    return {
      pipeline: {
        input: pipelineInput,
      },
      steps,
    };
  }

  private resolveTemplateExpression(expression: string, context: TemplateContext): unknown {
    const path = expression.trim().split('.');
    return this.getValueFromPath(context, path);
  }

  private getValueFromPath(obj: unknown, pathParts: string[]): unknown {
    let current = obj as Record<string, unknown> | undefined | null;
    for (const part of pathParts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part] as Record<string, unknown> | undefined | null;
    }
    return current;
  }

  private getMaxAttempts(stepConfig: PipelineStepConfig): number {
    const retries = Number(stepConfig.retries ?? 0);
    return Math.max(1, 1 + (Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0));
  }

  private parseDurationMs(duration: string | number | undefined): number | null {
    if (duration === undefined || duration === null) return null;
    if (typeof duration === 'number') return duration > 0 ? duration : null;

    const match = duration.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
    };

    return value * multipliers[unit];
  }

  private async failExecution(executionId: string, output: Record<string, unknown>): Promise<ExecutionEntity> {
    const failedExecution = await this.executionService.updateExecutionStatus(executionId, 'FAILED', output);
    await this.notifyGatewayUpdate(executionId);
    return failedExecution;
  }

  private async notifyGatewayUpdate(executionId: string) {
    try {
      const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:3000';
      const response = await fetch(`${gatewayUrl}/api/webhooks/execution-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId }),
      });

      if (!response.ok) {
        console.warn(`Gateway update webhook returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.warn('Failed to push execution status update webhook to gateway:', this.getErrorMessage(err));
    }
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
