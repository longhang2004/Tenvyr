import { Body, Controller, HttpException, HttpStatus, Post } from "@nestjs/common";
import { ProviderDiscoveryService } from "./services/provider-discovery.service";
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { RuntimeConnectionError } from "./services/runtime-connection.service";

/**
 * P2 closure (round 2): CONNECTION-SCOPED provider/model discovery.
 *
 * Everything here resolves the Runtime Connection by id, rejects
 * missing/revoked connections, and uses the CURRENT revision's fixed
 * secret-free profile — the frontend never supplies executables, cwd,
 * env, or runtimeKind.
 *
 * - discover / refresh-models / auth-methods: read-only runtime probes.
 * - test-target / oauth-authorize / oauth-callback: audited Workbench
 *   commands (operator actions with external side effects).
 */
@Controller("provider-discovery")
export class ProviderDiscoveryController {
  constructor(
    private readonly discovery: ProviderDiscoveryService,
    private readonly commands: WorkbenchCommandService,
  ) {}

  private withMapping<T>(fn: () => Promise<T>) {
    return fn().catch((error: unknown) => {
      if (error instanceof HttpException) throw error;
      const code = String((error as { code?: string }).code ?? "");
      const message = String((error as Error).message ?? "provider discovery failed");
      if (code === "CONNECTION_NOT_FOUND" || code === "CONNECTION_REVOKED") {
        throw new HttpException({ success: false, error: { code, message } }, HttpStatus.BAD_REQUEST);
      }
      if (
        code === "RUNTIME_NOT_SUPPORTED" ||
        code === "MODEL_NOT_SUPPORTED" ||
        code === "INVALID_MODEL_ID" ||
        code === "INVALID_OAUTH_URL" ||
        code === "OPENCODE_SERVER_FAILED"
      ) {
        throw new HttpException({ success: false, error: { code, message } }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (error instanceof RuntimeConnectionError) {
        throw new HttpException(
          { success: false, error: { code: error.code, message: error.message } },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        { success: false, error: { code: "PROVIDER_DISCOVERY_FAILED", message } },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    });
  }

  @Post("discover")
  async discover(@Body() body: { connectionId: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.discoverRuntimeProviders(body.connectionId);
      return { success: true, data };
    });
  }

  @Post("refresh-models")
  async refreshModels(@Body() body: { connectionId: string; providerId?: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.refreshRuntimeModels(
        body.connectionId,
        body.providerId,
      );
      return { success: true, data };
    });
  }

  @Post("auth-methods")
  async authMethods(@Body() body: { connectionId: string; providerId: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.getRuntimeProviderAuthMethods(
        body.connectionId,
        body.providerId,
      );
      return { success: true, data };
    });
  }

  @Post("commands/test-target")
  async testTarget(
    @Body() body: { idempotencyKey: string; connectionId: string; modelId: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.testRuntimeTarget({
        idempotencyKey: body.idempotencyKey,
        connectionId: body.connectionId,
        modelId: body.modelId,
      });
      return { success: true, data };
    });
  }

  @Post("commands/oauth-authorize")
  async oauthAuthorize(
    @Body() body: { idempotencyKey: string; connectionId: string; providerId: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.openCodeOauthAuthorize({
        idempotencyKey: body.idempotencyKey,
        connectionId: body.connectionId,
        providerId: body.providerId,
      });
      return { success: true, data };
    });
  }

  @Post("commands/oauth-callback")
  async oauthCallback(
    @Body() body: { idempotencyKey: string; connectionId: string; providerId: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.openCodeOauthCallback({
        idempotencyKey: body.idempotencyKey,
        connectionId: body.connectionId,
        providerId: body.providerId,
      });
      return { success: true, data };
    });
  }
}
