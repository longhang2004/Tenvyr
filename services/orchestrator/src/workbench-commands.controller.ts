import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  WorkbenchCommandError,
  WorkbenchCommandService,
} from "./services/workbench-command.service";
import type { CoordinationConfigV1 } from "./domain/coordination";

/**
 * M10-S2: idempotent local operator commands (loopback/private trusted
 * operator only). Commands go through existing authority services and
 * record durable audit evidence.
 */
@Controller("workbench/commands")
export class WorkbenchCommandsController {
  constructor(private readonly commands: WorkbenchCommandService) {}

  private mapError(error: unknown): never {
    if (error instanceof WorkbenchCommandError) {
      throw new (require("@nestjs/common").BadRequestException)(
        error.message,
      );
    }
    throw error;
  }

  @Post("start-team-run")
  async startTeamRun(
    @Body()
    body: {
      idempotencyKey: string;
      name?: string;
      goal: unknown;
      config: CoordinationConfigV1;
    },
  ) {
    try {
      return await this.commands.startTeamRun({
        idempotencyKey: body.idempotencyKey,
        name: body.name ?? "team-run",
        goal: body.goal,
        config: body.config,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post("waits/:runId")
  async resolveWait(
    @Param("runId") runId: string,
    @Body() body: { idempotencyKey: string; approve: boolean },
  ) {
    try {
      return await this.commands.resolveWait({
        idempotencyKey: body.idempotencyKey,
        runId,
        approve: body.approve,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post("executions/:executionId/cancel")
  async cancelExecution(
    @Param("executionId") executionId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    try {
      return await this.commands.cancelExecution({
        idempotencyKey: body.idempotencyKey,
        executionId,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post("executions/:executionId/replay")
  async replayExecution(
    @Param("executionId") executionId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    try {
      return await this.commands.replayExecution({
        idempotencyKey: body.idempotencyKey,
        executionId,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Post("compare")
  async compareExecutions(
    @Body()
    body: {
      idempotencyKey: string;
      executionA: string;
      executionB: string;
    },
  ) {
    try {
      return await this.commands.compareExecutions({
        idempotencyKey: body.idempotencyKey,
        executionA: body.executionA,
        executionB: body.executionB,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  @Get("audit")
  async audit(@Query("action") action?: string, @Query("limit") limit?: string) {
    return this.commands.auditTrail(
      action || undefined,
      Number.parseInt(limit ?? "50", 10),
    );
  }
}
