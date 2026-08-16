import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  WorkbenchProjectionError,
  WorkbenchProjectionService,
} from "./services/workbench-projection.service";
import { WorkspaceService } from "./services/workspace.service";
import {
  RuntimeOnboardingService,
  isOnboardingRuntimeKind,
} from "./services/runtime-onboarding.service";
import { AttentionService } from "./services/attention.service";

/**
 * M10-S1: bounded Workbench read projections (loopback/private trusted
 * operator only — the External Production Exposure Gate stays OPEN, so
 * this surface is internal). Product Phase 1 adds guided runtime
 * onboarding status and workspace identity reads.
 */
@Controller("workbench")
export class WorkbenchController {
  constructor(
    private readonly projection: WorkbenchProjectionService,
    private readonly workspaceService: WorkspaceService,
    private readonly onboarding: RuntimeOnboardingService,
    private readonly attention: AttentionService,
  ) {}

  /** PP1 Slice B: exception-driven Attention queue (READ projection —
   *  resolves nothing; action routes use the existing authority surfaces). */
  @Get("attention")
  async attentionQueue() {
    return this.attention.attention();
  }

  /** Product Phase 1: guided onboarding status for a supported runtime
   *  (Installed / Version / Auth — never credentials). */
  @Get("onboarding/:runtimeKind")
  async onboardingStatus(@Param("runtimeKind") runtimeKind: string) {
    if (!isOnboardingRuntimeKind(runtimeKind)) {
      return {
        error: {
          code: "RUNTIME_NOT_SUPPORTED",
          message: `onboarding supports ${RuntimeOnboardingService.kinds().join(", ")}`,
        },
      };
    }
    return { status: await this.onboarding.status(runtimeKind) };
  }

  /** Product Phase 1: stable workspace identities (bounded). */
  @Get("workspaces")
  async workspaces() {
    const rows = await this.workspaceService.list();
    return {
      workspaces: rows.map((row) => ({
        workspaceId: row.id,
        name: row.name,
        path: row.path,
        snapshot: row.snapshot,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

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
