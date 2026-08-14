import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { AgentAdapterError } from "./agent-adapters/agent-adapter.errors";
import type { ConnectionProfileV1 } from "./executors/runtime-connection";
import {
  RuntimeConnectionError,
  RuntimeConnectionService,
} from "./services/runtime-connection.service";
import {
  WorkbenchCommandError,
  WorkbenchCommandService,
} from "./services/workbench-command.service";
import { RUNTIME_PROFILE_TEMPLATES } from "./executors/runtime-profiles";

/**
 * M8-S5/S6 + M10-S2: LOCAL/INTERNAL connection product surface for the
 * operator workbench. The External Production Exposure Gate stays OPEN:
 * these endpoints are operator-local administration, not a public admin
 * API — no authentication or multi-user ownership is claimed.
 *
 * M10-S2: every authority-changing operation (create/revise/revoke) and
 * the health test go through the idempotent, audited Workbench command
 * layer — durable operator-action evidence commits with the mutation, and
 * retries with the same idempotencyKey converge on the stored outcome.
 */
@Controller("connections")
export class ConnectionsController {
  constructor(
    private readonly connections: RuntimeConnectionService,
    private readonly commands: WorkbenchCommandService,
  ) {}

  @Get()
  async list() {
    const data = await this.connections.listConnections();
    return { success: true, data };
  }

  /**
   * M8-S4/S6: version-pinned runtime templates for the Workbench onboarding
   * form. Secret-free by construction (templates carry references only).
   * Declared BEFORE the `:connectionId` route so the literal segment wins.
   */
  @Get("templates")
  async templates() {
    return {
      success: true,
      data: Object.values(RUNTIME_PROFILE_TEMPLATES).map((template) => ({
        runtimeKind: template.runtimeKind,
        pinnedVersion: template.pinnedVersion,
        sourceUrl: template.sourceUrl,
        accessedAt: template.accessedAt,
        runArgs: template.runArgs,
        probe: template.probe,
        ...(template.authProbe ? { authProbe: template.authProbe } : {}),
        credentialEnvRefs: template.credentialEnvRefs,
        declaredCapabilities: template.declaredCapabilities,
      })),
    };
  }

  /** M8-S6 + M10-S2: create a connection (revision 1) through the audited
   *  command layer. Bounded, secret-free. */
  @Post()
  async create(
    @Body()
    body: {
      idempotencyKey: string;
      connectionId: string;
      profile: ConnectionProfileV1;
    },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.createConnection({
        idempotencyKey: body.idempotencyKey,
        connectionId: body.connectionId,
        profile: body.profile,
      });
      return { success: true, data };
    });
  }

  /** M8-S6 + M10-S2: revise a connection (append immutable revision N+1)
   *  through the audited command layer. */
  @Patch(":connectionId")
  async revise(
    @Param("connectionId") connectionId: string,
    @Body() body: { idempotencyKey: string; profile: ConnectionProfileV1 },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.reviseConnection({
        idempotencyKey: body.idempotencyKey,
        connectionId,
        profile: body.profile,
      });
      return { success: true, data };
    });
  }

  @Get(":connectionId")
  async status(@Param("connectionId") connectionId: string) {
    return this.withMapping(async () => {
      const data = await this.connections.connectionStatus(connectionId);
      return { success: true, data };
    });
  }

  /** M10-S2: audited connection test (bounded receipt evidence). */
  @Post(":connectionId/test")
  async test(
    @Param("connectionId") connectionId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.testConnection({
        idempotencyKey: body.idempotencyKey,
        connectionId,
      });
      return { success: true, data };
    });
  }

  /** M10-S2: audited terminal revocation (one effective transition). */
  @Post(":connectionId/revoke")
  async revoke(
    @Param("connectionId") connectionId: string,
    @Body() body: { idempotencyKey: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.revokeConnection({
        idempotencyKey: body.idempotencyKey,
        connectionId,
      });
      return { success: true, data };
    });
  }

  /** Deterministic mapping of connection-domain errors to HTTP status. */
  private async withMapping<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkbenchCommandError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof RuntimeConnectionError) {
        if (error.code === "CONNECTION_NOT_FOUND") {
          throw new NotFoundException(error.message);
        }
        throw new BadRequestException(error.message);
      }
      if (error instanceof AgentAdapterError) {
        // Domain validation (profile/revision shape) is a client error.
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
