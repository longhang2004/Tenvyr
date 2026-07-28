import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("health")
  getHealth() {
    return {
      success: true,
      data: {
        status: "UP",
        service: "agent-code-reviewer",
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
        message: "Welcome to Tenvyr Code Reviewer Agent API",
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
