import type { AgentResultV1 } from "@tenvyr/contracts";
import { Injectable } from "@nestjs/common";
import type { AgentResultMessage } from "../agent-adapters/agent-adapter.types";
import { EngineService } from "./engine.service";
import { ExecutionService } from "./execution.service";

@Injectable()
export class AgentResultService {
  constructor(
    private readonly executionService: ExecutionService,
    private readonly engineService: EngineService,
  ) {}

  async handle({ result, transport }: AgentResultMessage): Promise<void> {
    console.log("Processing agent result", {
      adapter: transport.adapter,
      invocationId: result.invocationId,
      executionId: result.executionId,
      stepExecutionId: result.stepExecutionId,
      status: result.status,
      messageKey: transport.messageKey,
      topic: transport.topic,
      partition: transport.partition,
      offset: transport.offset,
      deliveryId: transport.deliveryId,
      dispatchId: transport.dispatchId,
      keyId: transport.keyId,
      remoteAddress: transport.remoteAddress,
    });

    const stepExecution = await this.executionService.getStepExecutionById(
      result.stepExecutionId,
    );
    if (!stepExecution || stepExecution.executionId !== result.executionId) {
      console.warn("Ignoring result for unknown step execution", {
        adapter: transport.adapter,
        invocationId: result.invocationId,
        executionId: result.executionId,
        stepExecutionId: result.stepExecutionId,
      });
      return;
    }

    const legacyAttempt = this.legacyAttempt(result);
    const expectedInvocationId = `${stepExecution.id}:${stepExecution.attempt}`;
    if (
      result.invocationId !== expectedInvocationId &&
      legacyAttempt === undefined
    ) {
      console.warn("Ignoring stale invocation result", {
        adapter: transport.adapter,
        invocationId: result.invocationId,
        expectedInvocationId,
        executionId: result.executionId,
        stepExecutionId: result.stepExecutionId,
      });
      return;
    }

    await this.engineService.handleStepCompletion(
      result.executionId,
      stepExecution.stepId,
      result.status === "succeeded" ? "COMPLETED" : "FAILED",
      result.output,
      result.error
        ? `${result.error.code}: ${result.error.message}`
        : undefined,
      legacyAttempt ?? stepExecution.attempt,
    );
  }

  private legacyAttempt(result: AgentResultV1): number | undefined {
    const legacy = result.metadata?.legacy;
    return this.isRecord(legacy) && typeof legacy.attempt === "number"
      ? legacy.attempt
      : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}
