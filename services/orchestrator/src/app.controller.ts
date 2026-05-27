import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  getHealth() {
    return {
      success: true,
      data: {
        status: 'UP',
        service: 'orchestrator',
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Get()
  getRoot() {
    return {
      success: true,
      data: {
        message: 'Welcome to AgentWeave Orchestrator API',
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
