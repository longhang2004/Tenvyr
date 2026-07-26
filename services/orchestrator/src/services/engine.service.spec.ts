import { EngineService } from './engine.service';

const execution = {
  id: 'execution-1',
  pipelineId: 'pipeline-1',
  status: 'RUNNING',
  input: { repository: 'agentweave' },
};

const stepConfig = {
  id: 'review',
  agent: 'code-reviewer',
  input: { code: 'const safe = true;' },
  timeout: '30s',
  retries: 2,
  onFailure: 'stop' as const,
};

const stepExecution = {
  id: 'step-execution-1',
  executionId: 'execution-1',
  stepId: 'review',
  agent: 'code-reviewer',
  status: 'RUNNING',
  input: stepConfig.input,
  output: null,
  error: null,
  attempt: 1,
  maxAttempts: 3,
};

describe('EngineService behavior', () => {
  let pipelineService: any;
  let executionService: any;
  let transport: any;
  let service: EngineService;

  beforeEach(() => {
    pipelineService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'pipeline-1',
        name: 'review pipeline',
        steps: [stepConfig],
      }),
    };
    executionService = {
      getStepExecution: jest.fn().mockResolvedValue(stepExecution),
      getStepExecutions: jest
        .fn()
        .mockResolvedValue([{ ...stepExecution, status: 'COMPLETED', output: { score: 100 } }]),
      updateStepStatus: jest.fn().mockResolvedValue(undefined),
      getExecution: jest.fn().mockResolvedValue(execution),
      updateExecutionStatus: jest.fn().mockImplementation(async (_id, status, output) => ({
        ...execution,
        status,
        output,
      })),
      createStepExecution: jest.fn().mockResolvedValue(stepExecution),
    };
    transport = {
      kind: 'kafka',
      invoke: jest.fn().mockResolvedValue({
        adapter: 'kafka',
        invocationId: 'step-execution-1:1',
        dispatchedAt: '2026-07-26T00:00:00.100Z',
        messageKey: 'execution-1',
      }),
      sendTask: jest.fn().mockResolvedValue(undefined),
    };
    service = new EngineService(pipelineService, executionService, transport);
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('applies a successful result and completes the execution', async () => {
    await service.handleStepCompletion('execution-1', 'review', 'COMPLETED', { score: 100 }, undefined, 1);

    expect(executionService.updateStepStatus).toHaveBeenCalledWith(
      'execution-1',
      'review',
      'COMPLETED',
      { score: 100 },
      undefined,
    );
    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith('execution-1', 'COMPLETED', {
      review: { score: 100 },
    });
  });

  it('applies a failed result through the existing stop policy', async () => {
    await service.handleStepCompletion('execution-1', 'review', 'FAILED', undefined, 'runner unavailable', 1);

    expect(executionService.updateStepStatus).toHaveBeenCalledWith(
      'execution-1',
      'review',
      'FAILED',
      undefined,
      'runner unavailable',
    );
    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      'execution-1',
      'FAILED',
      expect.objectContaining({
        failedStep: 'review',
        error: 'runner unavailable',
      }),
    );
  });

  it('ignores a duplicate terminal result', async () => {
    executionService.getStepExecution.mockResolvedValue({
      ...stepExecution,
      status: 'COMPLETED',
    });

    await service.handleStepCompletion('execution-1', 'review', 'COMPLETED', { score: 100 }, undefined, 1);

    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it('ignores a late result from an older attempt', async () => {
    executionService.getStepExecution.mockResolvedValue({
      ...stepExecution,
      attempt: 2,
    });

    await service.handleStepCompletion('execution-1', 'review', 'COMPLETED', { score: 100 }, undefined, 1);

    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it('ignores a result for an unknown step', async () => {
    executionService.getStepExecution.mockResolvedValue(null);

    await service.handleStepCompletion('execution-1', 'missing', 'COMPLETED', {}, undefined, 1);

    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it('marks the step RUNNING before dispatch and sends dispatch failure through the failure path', async () => {
    executionService.getStepExecution.mockResolvedValueOnce(null).mockResolvedValue(stepExecution);
    executionService.getStepExecutions.mockResolvedValue([]);
    transport.sendTask.mockRejectedValue(new Error('producer unavailable'));
    transport.invoke.mockRejectedValue(new Error('producer unavailable'));

    await (service as any).triggerStep(execution, {
      ...stepConfig,
      timeout: undefined,
    });

    expect(executionService.updateStepStatus.mock.calls[0]).toEqual(['execution-1', 'review', 'RUNNING']);
    expect(executionService.updateStepStatus).toHaveBeenCalledWith(
      'execution-1',
      'review',
      'FAILED',
      null,
      expect.stringContaining('dispatch failed'),
    );
  });

  it('creates the canonical invocation and delegates dispatch only to AgentAdapter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.getStepExecutions.mockResolvedValue([]);

    await (service as any).triggerStep(execution, stepConfig);

    expect(transport.invoke).toHaveBeenCalledWith({
      schemaVersion: '1',
      invocationId: 'step-execution-1:1',
      executionId: 'execution-1',
      stepExecutionId: 'step-execution-1',
      stepId: 'review',
      target: { agent: 'code-reviewer' },
      input: { code: 'const safe = true;' },
      attempt: 1,
      createdAt: '2026-07-26T00:00:00.000Z',
      deadlineAt: '2026-07-26T00:00:30.000Z',
      trace: {
        traceId: 'execution-1',
        correlationId: 'step-execution-1:1',
      },
      metadata: {
        orchestration: {
          maxAttempts: 3,
        },
      },
    });
    expect(transport.sendTask).not.toHaveBeenCalled();
  });

  it('does not change execution state based on the dispatch receipt', async () => {
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.getStepExecutions.mockResolvedValue([]);

    await (service as any).triggerStep(execution, {
      ...stepConfig,
      timeout: undefined,
    });

    expect(transport.invoke).toHaveBeenCalledTimes(1);
    expect(executionService.updateStepStatus).toHaveBeenCalledTimes(1);
    expect(executionService.updateStepStatus).toHaveBeenLastCalledWith('execution-1', 'review', 'RUNNING');
  });
});
