import { DataSource, type DataSourceOptions } from "typeorm";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { PipelineEntity } from "../entities/pipeline.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { AgentEventEntity } from "../entities/agent-event.entity";
import { AgentEventConflictEntity } from "../entities/agent-event-conflict.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { ArtifactExposureEntity } from "../entities/artifact-exposure.entity";
import { StateWriteEvidenceEntity } from "../entities/state-write-evidence.entity";
import { PlanProposalEntity } from "../entities/plan-proposal.entity";
import { DelegationObservationEntity } from "../entities/delegation-observation.entity";
import { DelegationObservationConflictEntity } from "../entities/delegation-observation-conflict.entity";
import { DelegationRequestEntity } from "../entities/delegation-request.entity";
import { DelegationRequestConflictEntity } from "../entities/delegation-request-conflict.entity";
import { ExecutionExportEntity } from "../entities/execution-export.entity";
import { ExecutionReplayEntity } from "../entities/execution-replay.entity";
import { RuntimeConnectionEntity } from "../entities/runtime-connection.entity";
import { ConnectionRevisionEntity } from "../entities/connection-revision.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import { WorkspaceEntity } from "../entities/workspace.entity";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import { BudgetAccountEntity } from "../entities/budget-account.entity";
import { BudgetReservationEntity } from "../entities/budget-reservation.entity";
import { BudgetLedgerEntryEntity } from "../entities/budget-ledger-entry.entity";
import { PolicySnapshotEntity } from "../entities/policy-snapshot.entity";
import { PolicyDecisionEntity } from "../entities/policy-decision.entity";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { MilestoneZeroFoundation1722270000000 } from "./migrations/1722270000000-MilestoneZeroFoundation";
import { MilestoneOneAgentEvents1722270001000 } from "./migrations/1722270001000-MilestoneOneAgentEvents";
import { MilestoneTwoArtifactIdentity1722270002000 } from "./migrations/1722270002000-MilestoneTwoArtifactIdentity";
import { MilestoneTwoExecutionState1722270003000 } from "./migrations/1722270003000-MilestoneTwoExecutionState";
import { MilestoneTwoArtifactExposure1722270004000 } from "./migrations/1722270004000-MilestoneTwoArtifactExposure";
import { MilestoneTwoStateWriteEvidence1722270005000 } from "./migrations/1722270005000-MilestoneTwoStateWriteEvidence";
import { MilestoneFivePlanProposals1722270009000 } from "./migrations/1722270009000-MilestoneFivePlanProposals";
import { MilestoneSixDelegationObservations1722270010000 } from "./migrations/1722270010000-MilestoneSixDelegationObservations";
import { MilestoneSixDelegationRequests1722270011000 } from "./migrations/1722270011000-MilestoneSixDelegationRequests";
import { MilestoneSevenCapsuleExports1722270012000 } from "./migrations/1722270012000-MilestoneSevenCapsuleExports";
import { MilestoneFourBudgetLedger1722270006000 } from "./migrations/1722270006000-MilestoneFourBudgetLedger";
import { MilestoneFourPolicy1722270007000 } from "./migrations/1722270007000-MilestoneFourPolicy";
import { MilestoneFourApprovals1722270008000 } from "./migrations/1722270008000-MilestoneFourApprovals";
import { RoadmapLineageIntegrity1722270013000 } from "./migrations/1722270013000-RoadmapLineageIntegrity";
import { MilestoneEightConnections1722270014000 } from "./migrations/1722270014000-MilestoneEightConnections";
import { MilestoneNineCoordination1722270015000 } from "./migrations/1722270015000-MilestoneNineCoordination";
import { MilestoneTenOperatorActions1722270016000 } from "./migrations/1722270016000-MilestoneTenOperatorActions";
import { WorkspaceIdentity1722270018000 } from "./migrations/1722270018000-WorkspaceIdentity";
import { CoordinationApprovalResume1722270017000 } from "./migrations/1722270017000-CoordinationApprovalResume";
import { ModelSources1722270019000 } from "./migrations/1722270019000-ModelSources";
import { ModelSourceEntity } from "../entities/model-source.entity";

export function databaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): DataSourceOptions {
  const processDefaults = {
    database: process.env.POSTGRES_DB || "agentweave",
  };
  const disposableDevelopment =
    env.NODE_ENV === "development" && env.TENVYR_DB_SYNCHRONIZE === "true";
  return {
    type: "postgres",
    host: env.POSTGRES_HOST || "localhost",
    port: Number.parseInt(env.POSTGRES_PORT || "5432", 10),
    username: env.POSTGRES_USER || "postgres",
    password: env.POSTGRES_PASSWORD || "postgres",
    database: env.POSTGRES_DB || processDefaults.database,
    entities: [
      PipelineEntity,
      ExecutionEntity,
      LogicalStepEntity,
      ExecutionPlanRevisionEntity,
      StepAttemptEntity,
      DispatchOutboxEntity,
      ResultInboxEntity,
      ResultConflictEntity,
      AgentEventEntity,
      AgentEventConflictEntity,
      ArtifactEntity,
      ArtifactExposureEntity,
      StateWriteEvidenceEntity,
      BudgetAccountEntity,
      BudgetReservationEntity,
      BudgetLedgerEntryEntity,
      PolicySnapshotEntity,
      PolicyDecisionEntity,
      ApprovalRequestEntity,
      PlanProposalEntity,
      DelegationObservationEntity,
      DelegationObservationConflictEntity,
      DelegationRequestEntity,
      DelegationRequestConflictEntity,
      ExecutionExportEntity,
      ExecutionReplayEntity,
      RuntimeConnectionEntity,
      ConnectionRevisionEntity,
      CoordinationRunEntity,
      CoordinationIterationEntity,
      WorkspaceEntity,
      OperatorActionEntity,
      ModelSourceEntity,
    ],
    migrations: [
      MilestoneZeroFoundation1722270000000,
      MilestoneOneAgentEvents1722270001000,
      MilestoneTwoArtifactIdentity1722270002000,
      MilestoneTwoExecutionState1722270003000,
      MilestoneTwoArtifactExposure1722270004000,
      MilestoneTwoStateWriteEvidence1722270005000,
      MilestoneFourBudgetLedger1722270006000,
      MilestoneFourPolicy1722270007000,
      MilestoneFourApprovals1722270008000,
      MilestoneFivePlanProposals1722270009000,
      MilestoneSixDelegationObservations1722270010000,
      MilestoneSixDelegationRequests1722270011000,
      MilestoneSevenCapsuleExports1722270012000,
      RoadmapLineageIntegrity1722270013000,
      MilestoneEightConnections1722270014000,
      MilestoneNineCoordination1722270015000,
      MilestoneTenOperatorActions1722270016000,
      CoordinationApprovalResume1722270017000,
      WorkspaceIdentity1722270018000,
      ModelSources1722270019000,
    ],
    migrationsRun:
      !disposableDevelopment && env.TENVYR_DB_MIGRATIONS !== "false",
    synchronize: disposableDevelopment,
  };
}

export const databaseProviders = [
  {
    provide: "DATA_SOURCE",
    useFactory: async () => {
      const dataSource = new DataSource(databaseOptions());

      return dataSource.initialize();
    },
  },
];
