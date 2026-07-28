import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { AgentAdapterRouter } from "./agent-adapter.router";

const invocation = (agent: string, input: unknown = {}): AgentInvocationV1 => ({
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "review",
  target: { agent },
  input: input as AgentInvocationV1["input"],
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: {
    traceId: "execution-1",
    correlationId: "step-execution-1:1",
  },
});

describe("AgentAdapterRouter", () => {
  let kafka: any;
  let http: any;
  let config: any;
  let router: AgentAdapterRouter;
  let handler: jest.Mock;

  beforeEach(() => {
    kafka = {
      kind: "kafka",
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      invoke: jest.fn().mockImplementation(async (value) => ({
        adapter: "kafka",
        invocationId: value.invocationId,
        dispatchedAt: "2026-07-26T00:00:01.000Z",
      })),
    };
    http = {
      kind: "http",
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      invoke: jest.fn().mockImplementation(async (value) => ({
        adapter: "http",
        invocationId: value.invocationId,
        dispatchedAt: "2026-07-26T00:00:01.000Z",
        dispatchId: "remote-run-1",
      })),
    };
    config = {
      forAgent: jest.fn().mockImplementation((agent) => ({
        kind: agent === "remote-security-reviewer" ? "http" : "kafka",
      })),
    };
    handler = jest.fn().mockResolvedValue(undefined);
    router = new AgentAdapterRouter(kafka, http, config);
  });

  it("routes exact HTTP agents to HTTP and preserves the receipt", async () => {
    const value = invocation("remote-security-reviewer");

    await router.start(handler);
    const receipt = await router.invoke(value);

    expect(http.invoke).toHaveBeenCalledWith(value);
    expect(kafka.invoke).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      adapter: "http",
      dispatchId: "remote-run-1",
    });
  });

  it.each(["code-reviewer", "observability", "unknown"])(
    "preserves Kafka routing for %s",
    async (agent) => {
      const value = invocation(agent);

      await router.start(handler);
      const receipt = await router.invoke(value);

      expect(kafka.invoke).toHaveBeenCalledWith(value);
      expect(http.invoke).not.toHaveBeenCalled();
      expect(receipt.adapter).toBe("kafka");
    },
  );

  it("selects transport only from the exact agent name", async () => {
    const input = {
      capability: "http",
      submitUrl: "https://attacker.example/v1/runs",
      agent: "remote-security-reviewer",
    };

    await router.start(handler);
    await router.invoke(invocation("code-reviewer", input));

    expect(config.forAgent).toHaveBeenCalledWith("code-reviewer");
    expect(kafka.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP", "remote-security-reviewer", "http", "kafka"],
    ["Kafka", "code-reviewer", "kafka", "http"],
  ])(
    "does not fallback when %s dispatch fails",
    async (_case, agent, failing, other) => {
      const failure = new Error("dispatch failed");
      (failing === "http" ? http : kafka).invoke.mockRejectedValue(failure);

      await router.start(handler);

      await expect(router.invoke(invocation(agent))).rejects.toBe(failure);
      expect((other === "http" ? http : kafka).invoke).not.toHaveBeenCalled();
    },
  );

  it("starts both adapters once with the same handler", async () => {
    await router.start(handler);
    await router.start(handler);

    expect(kafka.start).toHaveBeenCalledTimes(1);
    expect(http.start).toHaveBeenCalledTimes(1);
    expect(kafka.start).toHaveBeenCalledWith(handler);
    expect(http.start).toHaveBeenCalledWith(handler);
  });

  it("cleans up Kafka when HTTP startup fails", async () => {
    http.start.mockRejectedValue(new Error("HTTP startup failed"));

    await expect(router.start(handler)).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
    });
    expect(kafka.stop).toHaveBeenCalledTimes(1);
  });

  it("stops both adapters once and is sequentially idempotent", async () => {
    await router.start(handler);
    await router.stop();
    await router.stop();

    expect(http.stop).toHaveBeenCalledTimes(1);
    expect(kafka.stop).toHaveBeenCalledTimes(1);
  });

  it("best-effort stops the second adapter when the first stop fails", async () => {
    await router.start(handler);
    http.stop.mockRejectedValue(new Error("HTTP stop failed"));

    await expect(router.stop()).rejects.toMatchObject({
      code: "ADAPTER_STOP_FAILED",
    });
    expect(kafka.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects invoke before the router has started", async () => {
    await expect(
      router.invoke(invocation("code-reviewer")),
    ).rejects.toMatchObject({
      code: "ADAPTER_NOT_STARTED",
      adapter: "router",
    });
  });
});
