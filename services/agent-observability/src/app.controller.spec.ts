import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  describe('GET /health', () => {
    it('returns a successful health envelope identifying the agent-observability service', () => {
      const result = controller.getHealth();

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('UP');
      expect(result.data.service).toBe('agent-observability');
    });
  });
});
