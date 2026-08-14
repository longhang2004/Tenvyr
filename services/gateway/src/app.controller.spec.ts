import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { SocketGateway } from './socket.gateway';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const socketGatewayMock: Partial<SocketGateway> = {
      broadcastExecutionUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: SocketGateway, useValue: socketGatewayMock }],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  describe('GET /health', () => {
    it('returns a successful health envelope identifying the gateway service', () => {
      const result = controller.getHealth();

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('UP');
      expect(result.data.service).toBe('gateway');
    });
  });

  describe('connection product surface proxy', () => {
    it('forwards list/status/test/revoke to the orchestrator', async () => {
      const fetchMock = jest.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, data: { state: 'AVAILABLE' } }),
      }));
      (global as any).fetch = fetchMock;

      await controller.getConnections();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/connections'),
        expect.objectContaining({ method: 'GET' }),
      );

      await controller.getConnectionTemplates();
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining('/connections/templates'),
        expect.objectContaining({ method: 'GET' }),
      );

      await controller.getConnection('conn:codex-local');
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining('/connections/conn%3Acodex-local'),
        expect.anything(),
      );

      await controller.testConnection('conn:codex-local', {
        idempotencyKey: 'key-1',
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining('/connections/conn%3Acodex-local/test'),
        expect.objectContaining({ method: 'POST' }),
      );

      await controller.revokeConnection('conn:codex-local', {
        idempotencyKey: 'key-2',
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining('/connections/conn%3Acodex-local/revoke'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});

describe('workbench surface', () => {
  let app: any;
  let controller: any;

  beforeEach(async () => {
    const { AppController } = require("./app.controller");
    controller = new AppController({ emit: jest.fn() });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    (global as any).fetch = fetchMock;
    app = { controller, fetchMock };
  });

  it("serves the accessible Workbench page with labels and non-color-only status", async () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const page = readFileSync(
      join(__dirname, "workbench-page.html"),
      "utf8",
    );
    expect(page).toContain("<html lang=\"en\">");
    // Every input has a label; status is text, never color-only.
    expect(page).toContain("<label>");
    expect(page).toContain("Status:");
    expect(page).toContain("aria-live");
    expect(page).toContain("aria-labelledby");
    expect(page).toContain("table");
    // No inline event handlers with external code; scripts are local only.
    expect(page).not.toContain("eval(");
    expect(page).not.toContain("<script src=\"http");
    // The external-production limitation is visible in the UI itself.
    expect(page).toContain("External Production Exposure Gate");
  });

  it("forwards workbench command proxies to the orchestrator", async () => {
    await controller.startTeamRun({
      idempotencyKey: "key-1",
      name: "wedge",
      goal: "g",
      config: { maxIterations: 3 },
    });
    await controller.workbenchCancelExecution("execution-1", {
      idempotencyKey: "key-2",
    });
    const calls = (global as any).fetch.mock.calls;
    expect(calls[0][0]).toContain("/workbench/commands/start-team-run");
    expect(calls[0][1].method).toBe("POST");
    expect(calls[1][0]).toContain(
      "/workbench/commands/executions/execution-1/cancel",
    );
  });
});
