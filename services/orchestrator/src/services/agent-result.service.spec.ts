import type { AgentResultV1 } from "@tenvyr/contracts";
import { AgentResultService } from "./agent-result.service";

const stepExecution = {
  id: "step-execution-1",
  executionId: "execution-1",
  stepId: "review",
  status: "RUNNING",
  attempt: 1,
};

const result = (
  status: AgentResultV1["status"],
  overrides: Partial<AgentResultV1> = {},
): AgentResultV1 => ({
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  status,
  ...(status === "succeeded"
    ? { output: { score: 100 } }
    : {
        error: {
          code: "AGENT_FAILED",
          message: "runner unavailable",
          retryable: false,
        },
      }),
  completedAt: "2026-07-26T00:00:01.000Z",
  ...overrides,
});

const transport = {
  adapter: "kafka",
  receivedAt: "2026-07-26T00:00:01.100Z",
  topic: "ignored.for.business.logic",
  partition: 9,
};

describe("AgentResultService", () => {
  let executionService: any;
  let engineService: any;
  let service: AgentResultService;

  beforeEach(() => {
    executionService = {
      getStepExecutionById: jest.fn().mockResolvedValue(stepExecution),
    };
    engineService = {
      handleStepCompletion: jest.fn().mockResolvedValue(undefined),
    };
    service = new AgentResultService(executionService, engineService);
  });

  it("maps succeeded to the existing COMPLETED transition", async () => {
    await service.handle({ result: result("succeeded"), transport });

    expect(engineService.handleStepCompletion).toHaveBeenCalledWith(
      "execution-1",
      "review",
      "COMPLETED",
      { score: 100 },
      undefined,
      1,
    );
  });

  it.each(["failed", "cancelled", "timed_out"] as const)(
    "maps %s to the existing failure path",
    async (status) => {
      await service.handle({ result: result(status), transport });

      expect(engineService.handleStepCompletion).toHaveBeenCalledWith(
        "execution-1",
        "review",
        "FAILED",
        undefined,
        "runner unavailable",
        1,
      );
    },
  );

  it("ignores an unknown step execution", async () => {
    executionService.getStepExecutionById.mockResolvedValue(null);

    await expect(
      service.handle({ result: result("succeeded"), transport }),
    ).resolves.toBeUndefined();
    expect(engineService.handleStepCompletion).not.toHaveBeenCalled();
  });

  it("ignores an execution correlation mismatch", async () => {
    executionService.getStepExecutionById.mockResolvedValue({
      ...stepExecution,
      executionId: "different-execution",
    });

    await service.handle({ result: result("succeeded"), transport });
    expect(engineService.handleStepCompletion).not.toHaveBeenCalled();
  });

  it("ignores an invocation correlation mismatch", async () => {
    await service.handle({
      result: result("succeeded", {
        invocationId: "step-execution-1:2",
      }),
      transport,
    });

    expect(engineService.handleStepCompletion).not.toHaveBeenCalled();
  });

  it("preserves the legacy attempt for late-result handling", async () => {
    await service.handle({
      result: result("succeeded", {
        invocationId: "step-execution-1:0",
        metadata: { legacy: { stepId: "review", attempt: 0 } },
      }),
      transport,
    });

    expect(engineService.handleStepCompletion).toHaveBeenCalledWith(
      "execution-1",
      "review",
      "COMPLETED",
      { score: 100 },
      undefined,
      0,
    );
  });

  it("delegates a duplicate delivery to the existing idempotency boundary", async () => {
    await service.handle({ result: result("succeeded"), transport });
    await service.handle({ result: result("succeeded"), transport });

    expect(engineService.handleStepCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not use transport metadata for business decisions", async () => {
    await service.handle({
      result: result("succeeded"),
      transport: {
        ...transport,
        topic: "totally.different",
        partition: 999,
      },
    });

    expect(engineService.handleStepCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["succeeded", "COMPLETED"],
    ["failed", "FAILED"],
    ["cancelled", "FAILED"],
    ["timed_out", "FAILED"],
  ] as const)(
    "applies HTTP %s through the same %s transition",
    async (status, expected) => {
      await service.handle({
        result: result(status),
        transport: {
          adapter: "http",
          receivedAt: "2026-07-26T00:00:01.100Z",
          deliveryId: "delivery-1",
          keyId: "security-agent-v1",
        },
      });

      expect(engineService.handleStepCompletion).toHaveBeenCalledWith(
        "execution-1",
        "review",
        expected,
        status === "succeeded" ? { score: 100 } : undefined,
        status === "succeeded" ? undefined : "runner unavailable",
        1,
      );
    },
  );
});
