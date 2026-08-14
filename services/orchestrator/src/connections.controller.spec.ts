import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConnectionsController } from "./connections.controller";
import {
  RuntimeConnectionError,
  RuntimeConnectionService,
} from "./services/runtime-connection.service";
import {
  WorkbenchCommandError,
  WorkbenchCommandService,
} from "./services/workbench-command.service";
describe("ConnectionsController", () => {
  let controller: ConnectionsController;
  let serviceMock: Partial<RuntimeConnectionService>;
  let commandMock: Partial<WorkbenchCommandService>;

  beforeEach(async () => {
    serviceMock = {
      listConnections: jest.fn(),
      connectionStatus: jest.fn(),
    };
    commandMock = {
      createConnection: jest.fn(),
      reviseConnection: jest.fn(),
      revokeConnection: jest.fn(),
      testConnection: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConnectionsController],
      providers: [
        { provide: RuntimeConnectionService, useValue: serviceMock },
        { provide: WorkbenchCommandService, useValue: commandMock },
      ],
    }).compile();

    controller = module.get<ConnectionsController>(ConnectionsController);
  });

  it("lists connections with bounded status projections", async () => {
    (serviceMock.listConnections as jest.Mock).mockResolvedValue([
      {
        connectionId: "conn:codex-local",
        name: "Codex local",
        runtimeKind: "codex",
        executorId: "local-host",
        version: "0.147.0",
        status: { state: "DRAFT", reasonCode: "none" },
      },
    ]);
    const result = await controller.list();
    expect(result.success).toBe(true);
    expect(result.data[0].connectionId).toBe("conn:codex-local");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("exposes the version-pinned runtime templates (secret-free) for onboarding", async () => {
    const result = await controller.templates();
    expect(result.success).toBe(true);
    const kinds = result.data.map((template: { runtimeKind: string }) => template.runtimeKind);
    expect(kinds).toEqual(["codex", "claude", "opencode"]);
    for (const template of result.data) {
      expect(template.pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Array.isArray(template.runArgs)).toBe(true);
      expect(Array.isArray(template.credentialEnvRefs)).toBe(true);
      expect(template.probe).toBeDefined();
    }
    // References only — never values: the templates must not leak secrets.
    expect(JSON.stringify(result)).not.toMatch(/"name":\s*"(sk-|AKIA)/);
  });

  it("projects status, test receipts, and revocation through the audited command layer", async () => {
    (serviceMock.connectionStatus as jest.Mock).mockResolvedValue({
      state: "AVAILABLE",
      reasonCode: "none",
    });
    expect(await controller.status("conn:codex-local")).toMatchObject({
      success: true,
      data: { state: "AVAILABLE" },
    });

    (commandMock.testConnection as jest.Mock).mockResolvedValue({
      action: "test-connection",
      idempotencyKey: "key-1",
      outcome: "executed",
      result: {
        connectionId: "conn:codex-local",
        receipt: {
          revisionNumber: 1,
          testedAt: "2026-08-12T00:00:00.000Z",
          state: "AVAILABLE",
          reasonCode: "none",
          durationMs: 12,
        },
      },
    });
    const receipt = await controller.test("conn:codex-local", {
      idempotencyKey: "key-1",
    });
    expect(receipt).toMatchObject({
      success: true,
      data: { outcome: "executed" },
    });
    expect(commandMock.testConnection).toHaveBeenCalledWith({
      idempotencyKey: "key-1",
      connectionId: "conn:codex-local",
    });

    (commandMock.revokeConnection as jest.Mock).mockResolvedValue({
      action: "revoke-connection",
      idempotencyKey: "key-2",
      outcome: "executed",
      result: { connectionId: "conn:codex-local", status: { state: "REVOKED" } },
    });
    expect(
      await controller.revoke("conn:codex-local", { idempotencyKey: "key-2" }),
    ).toMatchObject({
      success: true,
      data: { outcome: "executed" },
    });
    expect(commandMock.revokeConnection).toHaveBeenCalledWith({
      idempotencyKey: "key-2",
      connectionId: "conn:codex-local",
    });
  });

  it("maps connection-domain errors deterministically to HTTP status", async () => {
    (serviceMock.connectionStatus as jest.Mock).mockRejectedValue(
      new RuntimeConnectionError(
        "CONNECTION_NOT_FOUND",
        'Runtime connection "conn:missing" does not exist',
      ),
    );
    await expect(controller.status("conn:missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );

    (commandMock.testConnection as jest.Mock).mockRejectedValue(
      new RuntimeConnectionError(
        "CONNECTION_REVOKED",
        'Runtime connection "conn:codex-local" is revoked',
      ),
    );
    await expect(
      controller.test("conn:codex-local", { idempotencyKey: "key-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Workbench command errors (invalid key, idempotency conflict) are 400.
    (commandMock.revokeConnection as jest.Mock).mockRejectedValue(
      new WorkbenchCommandError(
        "IDEMPOTENCY_CONFLICT",
        'idempotencyKey "key-1" was already used with a different request payload',
      ),
    );
    await expect(
      controller.revoke("conn:codex-local", { idempotencyKey: "key-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("M10-S2: creates and revises connections through the audited command layer", async () => {
    const profile = {
      name: "Codex local",
      runtimeKind: "codex",
      executorId: "local-host",
      version: "0.147.0",
      credentialRefs: [{ kind: "env", name: "CODEX_API_KEY" }],
      declaredCapabilities: {},
    };
    (commandMock.createConnection as jest.Mock).mockResolvedValue({
      action: "create-connection",
      idempotencyKey: "create-1",
      outcome: "executed",
      result: { connectionId: "conn:codex-local", revisionNumber: 1 },
    });
    const created = await controller.create({
      idempotencyKey: "create-1",
      connectionId: "conn:codex-local",
      profile: profile as never,
    });
    expect(created).toMatchObject({
      success: true,
      data: { outcome: "executed" },
    });
    expect(commandMock.createConnection).toHaveBeenCalledWith({
      idempotencyKey: "create-1",
      connectionId: "conn:codex-local",
      profile,
    });

    (commandMock.reviseConnection as jest.Mock).mockResolvedValue({
      action: "revise-connection",
      idempotencyKey: "revise-1",
      outcome: "executed",
      result: { connectionId: "conn:codex-local", revisionNumber: 2 },
    });
    const revised = await controller.revise("conn:codex-local", {
      idempotencyKey: "revise-1",
      profile: profile as never,
    });
    expect(revised).toMatchObject({
      success: true,
      data: { outcome: "executed" },
    });
    expect(commandMock.reviseConnection).toHaveBeenCalledWith({
      idempotencyKey: "revise-1",
      connectionId: "conn:codex-local",
      profile,
    });
  });

  it("M10-S2: duplicate/conflict creation maps to 400 and validation failures to 400", async () => {
    (commandMock.createConnection as jest.Mock).mockRejectedValue(
      new RuntimeConnectionError(
        "CONNECTION_ALREADY_EXISTS",
        'Runtime connection "conn:dup" already exists',
      ),
    );
    await expect(
      controller.create({
        idempotencyKey: "create-dup",
        connectionId: "conn:dup",
        profile: {} as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Workbench command validation errors (bad key, oversized payload) are
    // client errors too.
    (commandMock.createConnection as jest.Mock).mockRejectedValue(
      new WorkbenchCommandError(
        "INVALID_IDEMPOTENCY_KEY",
        "idempotencyKey must be 1-128 characters of [A-Za-z0-9_.:-]",
      ),
    );
    await expect(
      controller.create({
        idempotencyKey: "bad key!",
        connectionId: "conn:bad",
        profile: {} as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
