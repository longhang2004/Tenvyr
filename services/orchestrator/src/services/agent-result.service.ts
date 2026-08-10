import { Injectable } from "@nestjs/common";
import type { AgentResultMessage } from "../agent-adapters/agent-adapter.types";
import { EngineService } from "./engine.service";
import { ResultInboxService } from "./result-inbox.service";

@Injectable()
export class AgentResultService {
  constructor(
    private readonly resultInbox: ResultInboxService,
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

    const application = await this.resultInbox.apply(result, transport);
    if (application.disposition === "conflict") {
      console.error("Rejected conflicting terminal agent result", {
        adapter: transport.adapter,
        invocationId: result.invocationId,
      });
      return;
    }
    if (application.disposition === "ignored") {
      console.warn("Ignoring result for unknown or stale invocation", {
        adapter: transport.adapter,
        invocationId: result.invocationId,
      });
      return;
    }
    if (
      application.disposition === "applied" ||
      application.disposition === "duplicate"
    ) {
      await this.engineService.resumeAfterResult(
        application.executionId,
        application.stepId,
      );
    }
  }
}
