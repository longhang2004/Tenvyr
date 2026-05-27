import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  getHealth() {
    return {
      success: true,
      data: {
        status: 'UP',
        service: 'gateway',
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
        message: 'Welcome to AgentWeave Gateway API',
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
