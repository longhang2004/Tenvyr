import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { databaseProviders } from "./database/database.provider";
import { repositoryProviders } from "./database/repository.providers";
import { PipelineService } from "./services/pipeline.service";
import { ExecutionService } from "./services/execution.service";
import { KafkaService } from "./services/kafka.service";
import { EngineService } from "./services/engine.service";
import {
  AGENT_ADAPTER,
  AgentAdapterLifecycle,
  AgentAdapterRouter,
  AgentTransportConfigService,
  HttpAgentAdapter,
  HttpAgentCallbackController,
  KafkaAgentAdapter,
} from "./agent-adapters";
import { AgentResultService } from "./services/agent-result.service";
import { ConditionEvaluatorService } from "./services/condition-evaluator.service";
import { PipelineValidationService } from "./services/pipeline-validation.service";
import { ResultInboxService } from "./services/result-inbox.service";
import { DispatchOutboxService } from "./services/dispatch-outbox.service";
import { RuntimeRecoveryService } from "./services/runtime-recovery.service";
import { AgentEventService } from "./services/agent-event.service";
import { SupervisionConfigService } from "./services/supervision-config.service";
import { SupervisionService } from "./services/supervision.service";
import { ExecutionStateService } from "./services/execution-state.service";

@Module({
  imports: [],
  controllers: [AppController, HttpAgentCallbackController],
  providers: [
    ...databaseProviders,
    ...repositoryProviders,
    PipelineService,
    ConditionEvaluatorService,
    PipelineValidationService,
    ExecutionService,
    ResultInboxService,
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
    AgentEventService,
    SupervisionConfigService,
    SupervisionService,
    AgentAdapterLifecycle,
    DispatchOutboxService,
    RuntimeRecoveryService,
    ExecutionStateService,
  ],
  exports: [
    ...databaseProviders,
    ...repositoryProviders,
    PipelineService,
    ExecutionService,
    KafkaService,
    EngineService,
    AgentResultService,
    AgentEventService,
    ResultInboxService,
    DispatchOutboxService,
    ExecutionStateService,
    AGENT_ADAPTER,
  ],
})
export class AppModule {}
