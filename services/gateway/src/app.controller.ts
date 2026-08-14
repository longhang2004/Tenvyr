import { Controller, Get, Post, Patch, Body, Param, Query, Res } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SocketGateway } from "./socket.gateway";

const WORKBENCH_PAGE = readFileSync(
  join(__dirname, "workbench-page.html"),
  "utf8",
);

@Controller()
export class AppController {
  private orchestratorUrl: string;

  constructor(private socketGateway: SocketGateway) {
    this.orchestratorUrl =
      process.env.ORCHESTRATOR_URL || "http://localhost:3001";
  }

  @Get("health")
  getHealth() {
    return {
      success: true,
      data: {
        status: "UP",
        service: "gateway",
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Post("api/webhooks/execution-update")
  async handleExecutionWebhook(@Body() body: { executionId: string }) {
    const { executionId } = body;
    console.log(`Received execution webhook event for run: ${executionId}`);

    try {
      // Fetch full updated state from Orchestrator
      const data = await this.forwardToOrchestrator(
        `/executions/${executionId}`,
      );
      if (data.success) {
        this.socketGateway.broadcastExecutionUpdate(executionId, data.data);
      }
      return { success: true };
    } catch (err) {
      const message = this.getErrorMessage(err);
      console.error(
        `Failed to handle execution update for ${executionId}:`,
        message,
      );
      return { success: false, error: message };
    }
  }

  @Post("api/pipelines")
  async createPipeline(@Body() body: any) {
    return this.forwardToOrchestrator("/pipelines", {
      method: "POST",
      body,
    });
  }

  @Get("api/connections")
  async getConnections() {
    return this.forwardToOrchestrator("/connections");
  }

  /** M8-S4/S6: version-pinned runtime templates for the onboarding form.
   *  Declared before the `:connectionId` route (literal segment wins). */
  @Get("api/connections/templates")
  async getConnectionTemplates() {
    return this.forwardToOrchestrator("/connections/templates");
  }

  /** M8-S6: local operator create (revision 1). */
  @Post("api/connections")
  async createConnection(@Body() body: any) {
    return this.forwardToOrchestrator("/connections", {
      method: "POST",
      body,
    });
  }

  /** M8-S6: local operator revise (append immutable revision N+1). */
  @Patch("api/connections/:connectionId")
  async reviseConnection(
    @Param("connectionId") connectionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}`,
      { method: "PATCH", body },
    );
  }

  @Get("api/connections/:connectionId")
  async getConnection(@Param("connectionId") connectionId: string) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}`,
    );
  }

  @Get("api/workbench/connections")
  async getWorkbenchConnections() {
    return this.forwardToOrchestrator("/workbench/connections");
  }

  @Get("api/workbench/executions")
  async getWorkbenchExecutions(@Query("page") page?: string) {
    return this.forwardToOrchestrator(
      `/workbench/executions${page ? `?page=${encodeURIComponent(page)}` : ""}`,
    );
  }

  @Get("api/workbench/executions/:executionId")
  async getWorkbenchExecution(@Param("executionId") executionId: string) {
    return this.forwardToOrchestrator(
      `/workbench/executions/${encodeURIComponent(executionId)}`,
    );
  }

  @Post("api/workbench/commands/start-team-run")
  async startTeamRun(@Body() body: any) {
    return this.forwardToOrchestrator("/workbench/commands/start-team-run", {
      method: "POST",
      body,
    });
  }

  @Post("api/workbench/commands/waits/:runId")
  async resolveWait(@Param("runId") runId: string, @Body() body: any) {
    return this.forwardToOrchestrator(
      `/workbench/commands/waits/${encodeURIComponent(runId)}`,
      { method: "POST", body },
    );
  }

  @Post("api/workbench/commands/executions/:executionId/cancel")
  async workbenchCancelExecution(
    @Param("executionId") executionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/workbench/commands/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: "POST", body },
    );
  }

  @Post("api/workbench/commands/executions/:executionId/replay")
  async workbenchReplayExecution(
    @Param("executionId") executionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/workbench/commands/executions/${encodeURIComponent(executionId)}/replay`,
      { method: "POST", body },
    );
  }

  @Post("api/workbench/commands/compare")
  async workbenchCompare(@Body() body: any) {
    return this.forwardToOrchestrator("/workbench/commands/compare", {
      method: "POST",
      body,
    });
  }

  @Get("api/workbench/executions/:executionId/capsule")
  async getWorkbenchCapsule(@Param("executionId") executionId: string) {
    return this.forwardToOrchestrator(
      `/workbench/executions/${encodeURIComponent(executionId)}/capsule`,
    );
  }

  @Get("api/workbench/commands/audit")
  async workbenchAudit(@Query("action") action?: string) {
    return this.forwardToOrchestrator(
      `/workbench/commands/audit${action ? `?action=${encodeURIComponent(action)}` : ""}`,
    );
  }

  @Post("api/connections/:connectionId/test")
  async testConnection(
    @Param("connectionId") connectionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body },
    );
  }

  @Post("api/connections/:connectionId/revoke")
  async revokeConnection(
    @Param("connectionId") connectionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}/revoke`,
      { method: "POST", body },
    );
  }

  @Get("api/pipelines")
  async getPipelines() {
    return this.forwardToOrchestrator("/pipelines");
  }

  @Get("api/pipelines/:id")
  async getPipeline(@Param("id") id: string) {
    return this.forwardToOrchestrator(`/pipelines/${id}`);
  }

  @Post("api/executions")
  async triggerExecution(@Body() body: any) {
    return this.forwardToOrchestrator("/executions", {
      method: "POST",
      body,
    });
  }

  @Get("api/executions")
  async getExecutions() {
    return this.forwardToOrchestrator("/executions");
  }

  @Get("api/executions/:id")
  async getExecution(@Param("id") id: string) {
    return this.forwardToOrchestrator(`/executions/${id}`);
  }

  @Get("api/executions/:id/events")
  async getExecutionEvents(
    @Param("id") id: string,
    @Query("stepAttemptId") stepAttemptId?: string,
    @Query("type") type?: string,
    @Query("limit") limit?: string,
    @Query("afterReceivedAt") afterReceivedAt?: string,
    @Query("afterId") afterId?: string,
  ) {
    const params = new URLSearchParams();
    if (stepAttemptId) params.set("stepAttemptId", stepAttemptId);
    if (type) params.set("type", type);
    if (limit) params.set("limit", limit);
    if (afterReceivedAt) params.set("afterReceivedAt", afterReceivedAt);
    if (afterId) params.set("afterId", afterId);
    const query = params.toString();
    return this.forwardToOrchestrator(
      `/executions/${id}/events${query ? `?${query}` : ""}`,
    );
  }

  @Post("api/executions/:id/cancel")
  async cancelExecution(@Param("id") id: string) {
    return this.forwardToOrchestrator(`/executions/${id}/cancel`, {
      method: "POST",
    });
  }

  private async forwardToOrchestrator(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ) {
    try {
      const response = await fetch(`${this.orchestratorUrl}${path}`, {
        method: options.method || "GET",
        headers:
          options.body !== undefined
            ? { "Content-Type": "application/json" }
            : undefined,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

      const data = await response.json();
      if (!response.ok) {
        return {
          success: false,
          data: null,
          error:
            data.message ||
            data.error ||
            `Orchestrator returned HTTP ${response.status}`,
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

  @Get("workbench")
  getWorkbench(@Res() response: any) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.send(WORKBENCH_PAGE);
  }

  @Get()
  getRoot() {
    return {
      success: true,
      data: {
        message: "Welcome to Tenvyr Gateway API",
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
