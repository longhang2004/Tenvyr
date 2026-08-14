import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { PipelineService } from "./services/pipeline.service";
import { ExecutionService } from "./services/execution.service";
import { EngineService } from "./services/engine.service";
import { AgentEventService } from "./services/agent-event.service";
import * as yaml from "js-yaml";

@Controller()
export class AppController {
  constructor(
    private pipelineService: PipelineService,
    private executionService: ExecutionService,
    private engineService: EngineService,
    private eventService: AgentEventService,
  ) {}

  @Get("health")
  async getHealth() {
    // M11-S4: liveness vs readiness with safe reason codes. PostgreSQL is
    // the authority: readiness requires migrations applied and the DB
    // reachable. Never returns secrets or raw errors.
    const probe = await this.executionService.healthProbe();
    return {
      success: true,
      data: {
        status: probe.ready ? "UP" : "DEGRADED",
        service: "orchestrator",
        ready: probe.ready,
        reasonCode: probe.reasonCode,
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Post("pipelines")
  async createPipeline(@Body() body: any) {
    let pipelineData = body;

    // If input is a raw YAML string string, parse it
    if (typeof body === "string" || body.yamlString) {
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
        version: pipelineData.version || "1.0",
        description: pipelineData.description || "",
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

  @Get("pipelines")
  async getPipelines() {
    const pipelines = await this.pipelineService.findAll();
    return {
      success: true,
      data: pipelines,
    };
  }

  @Get("pipelines/:id")
  async getPipeline(@Param("id") id: string) {
    const pipeline = await this.pipelineService.findOne(id);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline not found`);
    }
    return {
      success: true,
      data: pipeline,
    };
  }

  @Post("executions")
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

  @Get("executions")
  async getExecutions() {
    const executions = await this.executionService.listExecutions();
    return {
      success: true,
      data: executions,
    };
  }

  @Get("executions/:id")
  async getExecution(@Param("id") id: string) {
    const execution = await this.executionService.getExecution(id);
    if (!execution) {
      throw new NotFoundException(`Execution not found`);
    }

    const logicalSteps = await this.executionService.getStepExecutions(id);
    const steps = await Promise.all(
      logicalSteps.map(async (step) => ({
        ...step,
        attempts: await this.executionService.getStepAttempts(step.id),
      })),
    );

    return {
      success: true,
      data: {
        ...execution,
        steps,
      },
    };
  }

  @Get("executions/:id/events")
  async getExecutionEvents(
    @Param("id") id: string,
    @Query("stepAttemptId") stepAttemptId?: string,
    @Query("type") type?: string,
    @Query("limit") limit?: string,
    @Query("afterReceivedAt") afterReceivedAt?: string,
    @Query("afterId") afterId?: string,
  ) {
    const execution = await this.executionService.getExecution(id);
    if (!execution) {
      throw new NotFoundException(`Execution not found`);
    }
    const requested = limit === undefined ? 50 : Number(limit);
    const bounded = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), 200)
      : 50;
    if ((afterReceivedAt === undefined) !== (afterId === undefined)) {
      throw new BadRequestException(
        `afterReceivedAt and afterId must be provided together`,
      );
    }
    let after: { receivedAt: Date; id: string } | undefined;
    if (afterReceivedAt !== undefined && afterId !== undefined) {
      const parsed = new Date(afterReceivedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(
          `afterReceivedAt must be an ISO-8601 timestamp`,
        );
      }
      after = { receivedAt: parsed, id: afterId };
    }
    const page = await this.eventService.list(id, {
      stepAttemptId,
      type,
      limit: bounded,
      after,
    });
    return {
      success: true,
      data: {
        events: page.events,
        next: page.next,
      },
    };
  }

  @Post("executions/:id/cancel")
  async cancelExecution(@Param("id") id: string) {
    try {
      const execution = await this.engineService.cancelExecution(id);
      return { success: true, data: execution };
    } catch (err) {
      if (this.getErrorMessage(err).includes("not found")) {
        throw new NotFoundException("Execution not found");
      }
      return {
        success: false,
        error: `Failed to cancel execution: ${this.getErrorMessage(err)}`,
      };
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
        message: "Welcome to Tenvyr Orchestrator API",
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
