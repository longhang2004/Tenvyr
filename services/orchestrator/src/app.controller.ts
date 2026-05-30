import { Controller, Get, Post, Body, Param, NotFoundException } from '@nestjs/common';
import { PipelineService } from './services/pipeline.service';
import { ExecutionService } from './services/execution.service';
import { EngineService } from './services/engine.service';
import * as yaml from 'js-yaml';

@Controller()
export class AppController {
  constructor(
    private pipelineService: PipelineService,
    private executionService: ExecutionService,
    private engineService: EngineService,
  ) {}

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

  @Post('pipelines')
  async createPipeline(@Body() body: any) {
    let pipelineData = body;
    
    // If input is a raw YAML string string, parse it
    if (typeof body === 'string' || body.yamlString) {
      const rawYaml = body.yamlString || body;
      try {
        pipelineData = yaml.load(rawYaml);
      } catch (err) {
        return {
          success: false,
          error: `Invalid YAML format: ${this.getErrorMessage(err)}`,
        };
      }
    }

    try {
      const pipeline = await this.pipelineService.create({
        name: pipelineData.name,
        version: pipelineData.version || '1.0',
        description: pipelineData.description || '',
        steps: pipelineData.steps || [],
      });

      return {
        success: true,
        data: pipeline,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to create pipeline: ${this.getErrorMessage(err)}`,
      };
    }
  }

  @Get('pipelines')
  async getPipelines() {
    const pipelines = await this.pipelineService.findAll();
    return {
      success: true,
      data: pipelines,
    };
  }

  @Get('pipelines/:id')
  async getPipeline(@Param('id') id: string) {
    const pipeline = await this.pipelineService.findOne(id);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline not found`);
    }
    return {
      success: true,
      data: pipeline,
    };
  }

  @Post('executions')
  async triggerExecution(@Body() body: { pipelineId: string; input: any }) {
    try {
      const execution = await this.engineService.startExecution(
        body.pipelineId,
        body.input || {},
      );
      return {
        success: true,
        data: execution,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to start execution: ${this.getErrorMessage(err)}`,
      };
    }
  }

  @Get('executions')
  async getExecutions() {
    const executions = await this.executionService.listExecutions();
    return {
      success: true,
      data: executions,
    };
  }

  @Get('executions/:id')
  async getExecution(@Param('id') id: string) {
    const execution = await this.executionService.getExecution(id);
    if (!execution) {
      throw new NotFoundException(`Execution not found`);
    }

    const steps = await this.executionService.getStepExecutions(id);
    
    return {
      success: true,
      data: {
        ...execution,
        steps,
      },
    };
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
