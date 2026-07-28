import { Body, Controller, INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ContractValidationError } from "@tenvyr/contracts";
import { AgentAdapterError } from "./agent-adapter.errors";
import { HttpAgentCallbackController } from "./http-agent-callback.controller";
import { HttpAgentAdapter } from "./http-agent.adapter";

@Controller("body-probe")
class BodyProbeController {
  @Post()
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

describe("HttpAgentCallbackController", () => {
  let app: INestApplication;
  let baseUrl: string;
  let adapter: { handleCallback: jest.Mock };

  beforeAll(async () => {
    adapter = { handleCallback: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [HttpAgentCallbackController, BodyProbeController],
      providers: [{ provide: HttpAgentAdapter, useValue: adapter }],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    adapter.handleCallback.mockReset().mockResolvedValue("processed");
  });

  const callback = (body = '{"schemaVersion":"1"}') =>
    fetch(`${baseUrl}/internal/agent-callbacks/http/remote-security-reviewer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentWeave-Key-Id": "security-agent-v1",
        "X-AgentWeave-Timestamp": "1785024000",
        "X-AgentWeave-Delivery-Id": "delivery-1",
        "X-AgentWeave-Signature": `v1=${"0".repeat(64)}`,
      },
      body,
    });

  it("passes exact raw bytes and authentication metadata to the adapter", async () => {
    const rawBody = '{ "schemaVersion": "1" }';

    const response = await callback(rawBody);

    expect(response.status).toBe(204);
    expect(adapter.handleCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "remote-security-reviewer",
        keyId: "security-agent-v1",
        timestamp: "1785024000",
        deliveryId: "delivery-1",
        rawBody: Buffer.from(rawBody),
      }),
    );
  });

  it("returns 204 for duplicate delivery", async () => {
    adapter.handleCallback.mockResolvedValue("duplicate");

    expect((await callback()).status).toBe(204);
  });

  it.each([
    [
      "authentication failure",
      new AgentAdapterError("CALLBACK_UNAUTHORIZED", "http", "unauthorized", {
        retryable: false,
      }),
      401,
    ],
    [
      "invalid JSON",
      new AgentAdapterError("CALLBACK_INVALID", "http", "invalid callback", {
        retryable: false,
      }),
      400,
    ],
    [
      "invalid result contract",
      new ContractValidationError("AgentResultV1", [
        { path: "/", message: "invalid" },
      ]),
      400,
    ],
    [
      "unavailable handler",
      new AgentAdapterError(
        "CALLBACK_HANDLER_UNAVAILABLE",
        "http",
        "unavailable",
        { retryable: true },
      ),
      503,
    ],
    [
      "handler failure",
      new AgentAdapterError("RESULT_HANDLER_FAILED", "http", "handler failed", {
        retryable: true,
      }),
      500,
    ],
  ])("maps %s to the expected HTTP status", async (_case, error, status) => {
    adapter.handleCallback.mockRejectedValue(error);

    const response = await callback();

    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(error.message);
  });

  it("keeps ordinary Nest JSON body parsing intact", async () => {
    const response = await fetch(`${baseUrl}/body-probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ still: "parsed" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ still: "parsed" });
  });
});
