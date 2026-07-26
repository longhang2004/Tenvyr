import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentResultService } from '../services/agent-result.service';
import { AGENT_ADAPTER } from './agent-adapter';
import type { AgentAdapter, AgentResultMessage } from './agent-adapter.types';

@Injectable()
export class AgentAdapterLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(AGENT_ADAPTER)
    private readonly adapter: AgentAdapter,
    private readonly resultService: AgentResultService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.adapter.start((message: AgentResultMessage) => this.resultService.handle(message));
  }

  async onModuleDestroy(): Promise<void> {
    await this.adapter.stop();
  }
}
