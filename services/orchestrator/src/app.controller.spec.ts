import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { PipelineService } from './services/pipeline.service';
import { ExecutionService } from './services/execution.service';
import { EngineService } from './services/engine.service';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const pipelineServiceMock: Partial<PipelineService> = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
    };
    const executionServiceMock: Partial<ExecutionService> = {
      listExecutions: jest.fn(),
      getExecution: jest.fn(),
      getStepExecutions: jest.fn(),
    };
    const engineServiceMock: Partial<EngineService> = {
      startExecution: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: PipelineService, useValue: pipelineServiceMock },
        { provide: ExecutionService, useValue: executionServiceMock },
        { provide: EngineService, useValue: engineServiceMock },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  describe('GET /health', () => {
    it('returns a successful health envelope identifying the orchestrator service', () => {
      const result = controller.getHealth();

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('UP');
      expect(result.data.service).toBe('orchestrator');
    });
  });
});
