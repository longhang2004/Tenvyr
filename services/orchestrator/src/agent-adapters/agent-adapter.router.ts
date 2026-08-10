import { Injectable } from '@nestjs/common';
import { AgentAdapterError } from './agent-adapter.errors';
import type { AgentAdapter, AgentAdapterHandlers, AgentDispatchReceipt } from './agent-adapter.types';
import { AgentTransportConfigService } from './agent-transport-config.service';
import { HttpAgentAdapter } from './http-agent.adapter';
import { KafkaAgentAdapter } from './kafka-agent.adapter';

@Injectable()
export class AgentAdapterRouter implements AgentAdapter {
  readonly kind = 'router';

  private started = false;

  constructor(
    private readonly kafkaAdapter: KafkaAgentAdapter,
    private readonly httpAdapter: HttpAgentAdapter,
    private readonly transportConfig: AgentTransportConfigService,
  ) {}

  async start(handlers: AgentAdapterHandlers): Promise<void> {
    if (this.started) return;

    let kafkaStarted = false;
    try {
      await this.kafkaAdapter.start(handlers);
      kafkaStarted = true;
      await this.httpAdapter.start(handlers);
      this.started = true;
    } catch (cause) {
      if (kafkaStarted) {
        try {
          await this.kafkaAdapter.stop();
        } catch {
          // Preserve the startup failure as the actionable error.
        }
      }
      throw new AgentAdapterError('ADAPTER_START_FAILED', this.kind, 'Agent adapter router failed to start', {
        retryable: true,
        cause,
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    let firstError: unknown;
    try {
      await this.httpAdapter.stop();
    } catch (cause) {
      firstError = cause;
    }
    try {
      await this.kafkaAdapter.stop();
    } catch (cause) {
      firstError ??= cause;
    }
    if (firstError) {
      throw new AgentAdapterError('ADAPTER_STOP_FAILED', this.kind, 'Agent adapter router failed to stop', {
        retryable: true,
        cause: firstError,
      });
    }
    this.started = false;
  }

  async invoke(invocation: Parameters<AgentAdapter['invoke']>[0]): Promise<AgentDispatchReceipt> {
    if (!this.started) {
      throw new AgentAdapterError('ADAPTER_NOT_STARTED', this.kind, 'Agent adapter router is not started', {
        invocationId: invocation.invocationId,
        retryable: true,
      });
    }

    return this.transportConfig.forAgent(invocation.target.agent).kind === 'http'
      ? this.httpAdapter.invoke(invocation)
      : this.kafkaAdapter.invoke(invocation);
  }
}
