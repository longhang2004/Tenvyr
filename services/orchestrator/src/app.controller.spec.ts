import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { PipelineService } from './services/pipeline.service';
import { ExecutionService } from './services/execution.service';
import { EngineService } from './services/engine.service';
import { AgentEventService } from './services/agent-event.service';

describe('AppController', () => {
  let controller: AppController;
  let pipelineServiceMock: Partial<PipelineService>;
  let executionServiceMock: Partial<ExecutionService>;
  let engineServiceMock: Partial<EngineService>;
  let eventServiceMock: { list: jest.Mock; apply: jest.Mock };

  beforeEach(async () => {
    pipelineServiceMock = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
    };
    executionServiceMock = {
      listExecutions: jest.fn(),
      getExecution: jest.fn(),
      getStepExecutions: jest.fn(),
      getStepAttempts: jest.fn(),
    };
    engineServiceMock = {
      startExecution: jest.fn(),
    };
    eventServiceMock = {
      list: jest.fn(),
      apply: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: PipelineService, useValue: pipelineServiceMock },
        { provide: ExecutionService, useValue: executionServiceMock },
        { provide: EngineService, useValue: engineServiceMock },
        { provide: AgentEventService, useValue: eventServiceMock },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  describe('GET /executions/:id/events validation', () => {
    beforeEach(() => {
      executionServiceMock.getExecution = jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: 'RUNNING',
      });
      (eventServiceMock.list as jest.Mock).mockResolvedValue({
        events: [],
      });
    });

    it('clamps the limit to the bounded range', async () => {
      await controller.getExecutionEvents('execution-1', undefined, undefined, '9999');
      expect(eventServiceMock.list).toHaveBeenCalledWith(
        'execution-1',
        expect.objectContaining({ limit: 200 }),
      );
    });

    it('rejects an unparseable cursor timestamp', async () => {
      await expect(
        controller.getExecutionEvents(
          'execution-1',
          undefined,
          undefined,
          undefined,
          'not-a-date',
          'id-1',
        ),
      ).rejects.toThrow();
    });

    it('rejects a one-sided cursor', async () => {
      await expect(
        controller.getExecutionEvents('execution-1', undefined, undefined, undefined, '2026-08-10T00:00:00.000Z'),
      ).rejects.toThrow();
    });
  });

  describe('GET /health', () => {
    it('returns a successful health envelope identifying the orchestrator service', async () => {
      (controller as any).executionService.healthProbe = jest
        .fn()
        .mockResolvedValue({ ready: true, reasonCode: "ready" });
      const result = await controller.getHealth();

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('UP');
      expect(result.data.service).toBe('orchestrator');
      expect(result.data.ready).toBe(true);
      expect(result.data.reasonCode).toBe('ready');
    });

    it('reports DEGRADED with a safe reason code when migrations are missing', async () => {
      (controller as any).executionService.healthProbe = jest
        .fn()
        .mockResolvedValue({ ready: false, reasonCode: "migrations-required" });
      const result = await controller.getHealth();

      expect(result.data.status).toBe('DEGRADED');
      expect(result.data.reasonCode).toBe('migrations-required');
      expect(JSON.stringify(result)).not.toContain('secret');
    });
  });

  describe('GET /executions/:id additive compatibility', () => {
    it('keeps protocol-v1 step fields and adds nested immutable attempt history', async () => {
      const executionService = controller as any;
      executionService.executionService.getExecution.mockResolvedValue({
        id: 'execution-1',
        pipelineId: 'pipeline-1',
        status: 'RUNNING',
        terminationReason: null,
      });
      executionService.executionService.getStepExecutions.mockResolvedValue([
        {
          id: 'logical-1',
          executionId: 'execution-1',
          stepId: 'review',
          agent: 'reviewer',
          status: 'RUNNING',
          output: null,
          error: null,
          attempt: 1,
          maxAttempts: 2,
        },
      ]);
      executionService.executionService.getStepAttempts.mockResolvedValue([
        {
          id: 'attempt-1',
          logicalStepId: 'logical-1',
          attemptNumber: 1,
          invocationId: 'logical-1:1',
          status: 'RUNNING',
          inputSnapshot: { run: 1 },
        },
      ]);

      const response = await controller.getExecution('execution-1');

      expect(response.success).toBe(true);
      const step = response.data.steps[0];
      expect(step).toEqual(
        expect.objectContaining({
          id: 'logical-1',
          stepId: 'review',
          status: 'RUNNING',
          attempt: 1,
        }),
      );
      expect(step.attempts).toHaveLength(1);
      expect(step.attempts[0]).toEqual(
        expect.objectContaining({
          attemptNumber: 1,
          invocationId: 'logical-1:1',
          status: 'RUNNING',
        }),
      );
    });
  });
});
