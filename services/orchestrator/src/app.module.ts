import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { ConnectionsController } from "./connections.controller";
import { WorkbenchController } from "./workbench.controller";
import { WorkbenchCommandsController } from "./workbench-commands.controller";
import { ModelSourcesController } from "./model-sources.controller";
import { ProviderDiscoveryController } from "./provider-discovery.controller";
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
import { BudgetLedgerService } from "./services/budget-ledger.service";
import { PolicyService } from "./services/policy.service";
import { ApprovalService } from "./services/approval.service";
import { PlanProposalService } from "./services/plan-proposal.service";
import { DelegationService } from "./services/delegation.service";
import { ExecutionCapsuleService } from "./services/execution-capsule.service";
import { RuntimeConnectionService } from "./services/runtime-connection.service";
import { RuntimeCoordinationService } from "./services/runtime-coordination.service";
import { WorkbenchProjectionService } from "./services/workbench-projection.service";
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { WorkspaceService } from "./services/workspace.service";
import { ModelSourceService } from "./services/model-source.service";
import { ProviderDiscoveryService } from "./services/provider-discovery.service";
import { RuntimeOnboardingService } from "./services/runtime-onboarding.service";

@Module({
  imports: [],
  controllers: [
    AppController,
    HttpAgentCallbackController,
    ConnectionsController,
    WorkbenchController,
    WorkbenchCommandsController,
    ModelSourcesController,
    ProviderDiscoveryController,
  ],
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
    BudgetLedgerService,
    PolicyService,
    ApprovalService,
    PlanProposalService,
    DelegationService,
    ExecutionCapsuleService,
    RuntimeConnectionService,
    RuntimeCoordinationService,
    WorkbenchProjectionService,
    WorkbenchCommandService,
    WorkspaceService,
    RuntimeOnboardingService,
    ModelSourceService,
    ProviderDiscoveryService,
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
    BudgetLedgerService,
    PolicyService,
    ApprovalService,
    PlanProposalService,
    DelegationService,
    ExecutionCapsuleService,
    AGENT_ADAPTER,
  ],
})
export class AppModule {}
