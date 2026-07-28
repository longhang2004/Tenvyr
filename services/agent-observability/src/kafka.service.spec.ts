import { parseAgentResult } from "@tenvyr/contracts";
import { KafkaService } from "./kafka.service";

const messagePayload = (value: unknown) =>
  ({
    message: {
      key: Buffer.from("execution-1"),
      value: Buffer.from(JSON.stringify(value)),
      timestamp: "1785024000000",
    },
  }) as any;

describe("KafkaService contract boundary", () => {
  let service: KafkaService;
  let send: jest.Mock;

  beforeEach(() => {
    service = new KafkaService();
    send = jest.fn().mockResolvedValue(undefined);
    (service as any).producer = { send };
    (service as any).callRunner = jest.fn().mockResolvedValue({
      data: { output: '{"status":"HEALTHY","analysis":"ok","latencySec":1}' },
    });
  });

  it.each([
    [
      "v1",
      {
        schemaVersion: "1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        stepId: "observe",
        target: { agent: "observability" },
        input: { logs: "all good", findings: [] },
        attempt: 1,
        createdAt: "2026-07-26T00:00:00.000Z",
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      },
    ],
    [
      "legacy",
      {
        executionId: "execution-1",
        stepId: "observe",
        agent: "observability",
        input: { logs: "all good", findings: [] },
        attempt: 1,
        timestamp: "2026-07-26T00:00:00.000Z",
      },
    ],
  ])(
    "accepts a %s invocation and publishes a v1 result",
    async (_kind, invocation) => {
      await (service as any).processTask(messagePayload(invocation));

      const request = send.mock.calls[0][0];
      const result = parseAgentResult(JSON.parse(request.messages[0].value));
      expect(request.topic).toBe("agentweave.agent.observability.result");
      expect(result.status).toBe("succeeded");
      expect(result.executionId).toBe("execution-1");
    },
  );

  it("does not crash, call the runner, or publish success for an invalid task", async () => {
    await expect(
      (service as any).processTask(
        messagePayload({ executionId: "execution-1" }),
      ),
    ).resolves.toBeUndefined();
    expect((service as any).callRunner).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not log malformed invocation contents", async () => {
    const error = jest.spyOn(console, "error").mockImplementation();
    const payload = messagePayload({});
    payload.message.value = Buffer.from("{TOP_SECRET:not-json");

    await (service as any).processTask(payload);

    expect(JSON.stringify(error.mock.calls)).not.toContain("TOP_SECRET");
    expect((service as any).callRunner).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
