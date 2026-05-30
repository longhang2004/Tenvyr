import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { SocketGateway } from './socket.gateway';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const socketGatewayMock: Partial<SocketGateway> = {
      broadcastExecutionUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: SocketGateway, useValue: socketGatewayMock }],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  describe('GET /health', () => {
    it('returns a successful health envelope identifying the gateway service', () => {
      const result = controller.getHealth();

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('UP');
      expect(result.data.service).toBe('gateway');
    });
  });
});
