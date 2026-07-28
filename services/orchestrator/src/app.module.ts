import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { databaseProviders } from './database/database.provider';
import { repositoryProviders } from './database/repository.providers';
import { PipelineService } from './services/pipeline.service';
import { ExecutionService } from './services/execution.service';
import { KafkaService } from './services/kafka.service';
import { EngineService } from './services/engine.service';
import {
  AGENT_ADAPTER,
  AgentAdapterLifecycle,
  AgentAdapterRouter,
  AgentTransportConfigService,
  HttpAgentAdapter,
  HttpAgentCallbackController,
  KafkaAgentAdapter,
} from './agent-adapters';
import { AgentResultService } from './services/agent-result.service';

@Module({
  imports: [],
  controllers: [AppController, HttpAgentCallbackController],
  providers: [
    ...databaseProviders,
    ...repositoryProviders,
    PipelineService,
    ExecutionService,
    KafkaService,
    KafkaAgentAdapter,
    HttpAgentAdapter,
    AgentAdapterRouter,
    {
      provide: AgentTransportConfigService,
      useFactory: () => new AgentTransportConfigService(),
    },
    {
      provide: AGENT_ADAPTER,
      useExisting: AgentAdapterRouter,
    },
    EngineService,
    AgentResultService,
    AgentAdapterLifecycle,
  ],
  exports: [
    ...databaseProviders,
    ...repositoryProviders,
    PipelineService,
    ExecutionService,
    KafkaService,
    EngineService,
    AgentResultService,
    AGENT_ADAPTER,
  ],
})
export class AppModule {}
