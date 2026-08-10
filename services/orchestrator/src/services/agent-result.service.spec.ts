import type { AgentResultV1 } from "@tenvyr/contracts";
import { AgentResultService } from "./agent-result.service";

const result: AgentResultV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  status: "succeeded",
  output: { score: 100 },
  completedAt: "2026-07-26T00:00:01.000Z",
};

const transport = {
  adapter: "kafka",
  receivedAt: "2026-07-26T00:00:01.100Z",
  topic: "ignored.for.business.logic",
  partition: 9,
  offset: "42",
};

describe("AgentResultService", () => {
  let inbox: { apply: jest.Mock };
  let engine: { resumeAfterResult: jest.Mock };
  let service: AgentResultService;

  beforeEach(() => {
    inbox = {
      apply: jest.fn().mockResolvedValue({
        disposition: "applied",
        executionId: "execution-1",
        stepId: "review",
      }),
    };
    engine = { resumeAfterResult: jest.fn().mockResolvedValue(undefined) };
    service = new AgentResultService(inbox as any, engine as any);
  });

  it("uses the transport-neutral durable inbox before progression", async () => {
    await service.handle({ result, transport });

    expect(inbox.apply).toHaveBeenCalledWith(result, transport);
    expect(engine.resumeAfterResult).toHaveBeenCalledWith(
      "execution-1",
      "review",
    );
  });

  it("replays idempotent progression for an identical duplicate delivery", async () => {
    inbox.apply.mockResolvedValue({
      disposition: "duplicate",
      executionId: "execution-1",
      stepId: "review",
    });

    await service.handle({ result, transport });

    expect(engine.resumeAfterResult).toHaveBeenCalledWith(
      "execution-1",
      "review",
    );
  });

  it("does not progress a conflicting or stale delivery", async () => {
    inbox.apply.mockResolvedValueOnce({ disposition: "conflict" });
    await service.handle({ result, transport });
    inbox.apply.mockResolvedValueOnce({ disposition: "ignored" });
    await service.handle({ result, transport });

    expect(engine.resumeAfterResult).not.toHaveBeenCalled();
  });

  it("propagates recoverable inbox failures to the transport", async () => {
    inbox.apply.mockRejectedValue(new Error("database unavailable"));

    await expect(service.handle({ result, transport })).rejects.toThrow(
      "database unavailable",
    );
  });
});
