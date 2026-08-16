import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type {
  ModelCatalogSnapshotV1,
  ModelSourceV1,
} from "./executors/model-source";
import {
  ModelSourceDomainError,
  ModelSourceService,
} from "./services/model-source.service";
import {
  WorkbenchCommandError,
  WorkbenchCommandService,
} from "./services/workbench-command.service";

/**
 * P2: LOCAL/INTERNAL model-source product surface for the operator
 * workbench (same exposure stance as connections: single-owner operator
 * feature; the External Production Exposure Gate stays open). Every
 * authority-changing operation goes through the idempotent, audited
 * Workbench command layer.
 */
@Controller("model-sources")
export class ModelSourcesController {
  constructor(
    private readonly sources: ModelSourceService,
    private readonly commands: WorkbenchCommandService,
  ) {}

  @Get()
  async list() {
    const data = await this.sources.list();
    return { success: true, data };
  }

  @Post()
  async create(@Body() body: { idempotencyKey: string; source: unknown }) {
    return this.withMapping(async () => {
      const data = await this.commands.createModelSource({
        idempotencyKey: body.idempotencyKey,
        source: body.source,
      });
      return { success: true, data };
    });
  }

  @Patch(":sourceId")
  async update(
    @Param("sourceId") sourceId: string,
    @Body() body: { idempotencyKey: string; patch: unknown },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.updateModelSource({
        idempotencyKey: body.idempotencyKey,
        sourceId,
        patch: body.patch,
      });
      return { success: true, data };
    });
  }

  @Delete(":sourceId")
  async remove(
    @Param("sourceId") sourceId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.deleteModelSource({
        idempotencyKey: body.idempotencyKey,
        sourceId,
      });
      return { success: true, data };
    });
  }

  /** Test Model Source: endpoint reachable + auth accepted + catalog
   *  retrievable. Never proves inference. */
  @Post(":sourceId/test")
  async test(
    @Param("sourceId") sourceId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.testModelSource({
        idempotencyKey: body.idempotencyKey,
        sourceId,
      });
      return { success: true, data };
    });
  }

  /** Refresh Models: bounded on-demand catalog projection (never
   *  persisted). Returns the snapshot for immediate use. */
  @Post(":sourceId/refresh")
  async refresh(
    @Param("sourceId") sourceId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.refreshModelSource({
        idempotencyKey: body.idempotencyKey,
        sourceId,
      });
      return { success: true, data };
    });
  }

  private async withMapping<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkbenchCommandError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof ModelSourceDomainError) {
        if (error.code === "SOURCE_NOT_FOUND") {
          throw new NotFoundException(error.message);
        }
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

export type { ModelCatalogSnapshotV1, ModelSourceV1 };
