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
      workspace?: { workspaceId: string } | { path: string };
      acceptanceEvidence?: unknown;
    },
  ) {
    try {
      return await this.commands.startTeamRun({
        idempotencyKey: body.idempotencyKey,
        name: body.name ?? "team-run",
        goal: body.goal,
        config: body.config,
        ...(body.workspace ? { workspace: body.workspace } : {}),
        ...(body.acceptanceEvidence !== undefined
          ? { acceptanceEvidence: body.acceptanceEvidence }
          : {}),
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  /** Product Phase 1: one-click guided runtime onboarding. */
  @Post("onboard-runtime")
  async onboardRuntime(
    @Body()
    body: {
      idempotencyKey: string;
      runtimeKind: string;
      connectionId?: string;
      name?: string;
    },
  ) {
    try {
      return await this.commands.onboardRuntime({
        idempotencyKey: body.idempotencyKey,
        runtimeKind: body.runtimeKind,
        ...(body.connectionId ? { connectionId: body.connectionId } : {}),
        ...(body.name ? { name: body.name } : {}),
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  /** Product Phase 1: create/refresh a stable workspace from a path. */
  @Post("create-workspace")
  async createWorkspace(
    @Body()
    body: {
      idempotencyKey: string;
      name?: string;
      path: string;
    },
  ) {
    try {
      return await this.commands.createWorkspace({
        idempotencyKey: body.idempotencyKey,
        ...(body.name ? { name: body.name } : {}),
        path: body.path,
      });
    } catch (error) {
      this.mapError(error);
    }
  }

  /** Product Phase 1: bounded team templates. */
  @Get("team-templates")
  async teamTemplates() {
    return { templates: this.commands.teamTemplates() };
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

  /** PP1 Slice C: continue a TERMINAL run on a NEW Runtime Target. */
  @Post("executions/:executionId/continue")
  async continueRun(
    @Param("executionId") executionId: string,
    @Body()
    body: {
      idempotencyKey: string;
      config: CoordinationConfigV1;
    },
  ) {
    try {
      return await this.commands.continueRun({
        idempotencyKey: body.idempotencyKey,
        sourceExecutionId: executionId,
        config: body.config,
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

  @Post("workspaces/:workspaceExecutionId/release")
  async releaseWorkspace(
    @Param("workspaceExecutionId") workspaceExecutionId: string,
    @Body()
    body: {
      idempotencyKey: string;
      reason?: string;
    },
  ) {
    try {
      return await this.commands.releaseExecutionWorkspace({
        idempotencyKey: body.idempotencyKey,
        workspaceExecutionId,
        ...(body.reason ? { reason: body.reason } : {}),
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
