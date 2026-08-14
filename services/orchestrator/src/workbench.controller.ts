import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  WorkbenchProjectionError,
  WorkbenchProjectionService,
} from "./services/workbench-projection.service";

/**
 * M10-S1: bounded Workbench read projections (loopback/private trusted
 * operator only — the External Production Exposure Gate stays OPEN, so
 * this surface is internal).
 */
@Controller("workbench")
export class WorkbenchController {
  constructor(private readonly projection: WorkbenchProjectionService) {}

  @Get("connections")
  async connectionCards() {
    return this.projection.connectionCards();
  }

  @Get("executions/:executionId/capsule")
  async capsule(@Param("executionId") executionId: string) {
    try {
      const capsule = await this.projection.capsuleFor(executionId);
      return { capsule };
    } catch (error) {
      if (error instanceof WorkbenchProjectionError) {
        return { error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  }

  @Get("executions")
  async executions(@Query("page") page?: string) {
    const parsedPage = Number.parseInt(page ?? "1", 10);
    return this.projection.executionSummaries(
      Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    );
  }

  @Get("executions/:executionId")
  async execution(@Param("executionId") executionId: string) {
    try {
      return await this.projection.executionProjection(executionId);
    } catch (error) {
      if (error instanceof WorkbenchProjectionError) {
        return {
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      throw error;
    }
  }
}
