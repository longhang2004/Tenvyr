import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentResultService } from '../services/agent-result.service';
import { AgentEventService } from '../services/agent-event.service';
import { AGENT_ADAPTER } from './agent-adapter';
import type { AgentAdapter, AgentResultMessage, AgentEventMessage } from './agent-adapter.types';

@Injectable()
export class AgentAdapterLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(AGENT_ADAPTER)
    private readonly adapter: AgentAdapter,
    private readonly resultService: AgentResultService,
    private readonly eventService: AgentEventService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.adapter.start({
      result: (message: AgentResultMessage) => this.resultService.handle(message),
      event: (message: AgentEventMessage) => this.eventService.handle(message),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.adapter.stop();
  }
}
