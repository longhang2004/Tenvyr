import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';

@Controller()
export class AppController {
  private orchestratorUrl: string;

  constructor(private socketGateway: SocketGateway) {
    this.orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3001';
  }

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

  @Post('api/webhooks/execution-update')
  async handleExecutionWebhook(@Body() body: { executionId: string }) {
    const { executionId } = body;
    console.log(`Received execution webhook event for run: ${executionId}`);

    try {
      // Fetch full updated state from Orchestrator
      const data = await this.forwardToOrchestrator(`/executions/${executionId}`);
      if (data.success) {
        this.socketGateway.broadcastExecutionUpdate(executionId, data.data);
      }
      return { success: true };
    } catch (err) {
      const message = this.getErrorMessage(err);
      console.error(`Failed to handle execution update for ${executionId}:`, message);
      return { success: false, error: message };
    }
  }

  @Post('api/pipelines')
  async createPipeline(@Body() body: any) {
    return this.forwardToOrchestrator('/pipelines', {
      method: 'POST',
      body,
    });
  }

  @Get('api/pipelines')
  async getPipelines() {
    return this.forwardToOrchestrator('/pipelines');
  }

  @Get('api/pipelines/:id')
  async getPipeline(@Param('id') id: string) {
    return this.forwardToOrchestrator(`/pipelines/${id}`);
  }

  @Post('api/executions')
  async triggerExecution(@Body() body: any) {
    return this.forwardToOrchestrator('/executions', {
      method: 'POST',
      body,
    });
  }

  @Get('api/executions')
  async getExecutions() {
    return this.forwardToOrchestrator('/executions');
  }

  @Get('api/executions/:id')
  async getExecution(@Param('id') id: string) {
    return this.forwardToOrchestrator(`/executions/${id}`);
  }

  private async forwardToOrchestrator(path: string, options: { method?: string; body?: unknown } = {}) {
    try {
      const response = await fetch(`${this.orchestratorUrl}${path}`, {
        method: options.method || 'GET',
        headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

      const data = await response.json();
      if (!response.ok) {
        return {
          success: false,
          data: null,
          error: data.message || data.error || `Orchestrator returned HTTP ${response.status}`,
        };
      }
      return data;
    } catch (err) {
      return { success: false, data: null, error: this.getErrorMessage(err) };
    }
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
