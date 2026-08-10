import { DataSource } from "typeorm";
import { PipelineEntity } from "../entities/pipeline.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { StepExecutionEntity } from "../entities/step-execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { AgentEventEntity } from "../entities/agent-event.entity";
import { AgentEventConflictEntity } from "../entities/agent-event-conflict.entity";

export const repositoryProviders = [
  {
    provide: "PIPELINE_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(PipelineEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "EXECUTION_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(ExecutionEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "STEP_EXECUTION_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(StepExecutionEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "LOGICAL_STEP_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(StepExecutionEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "EXECUTION_PLAN_REVISION_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(ExecutionPlanRevisionEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "STEP_ATTEMPT_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(StepAttemptEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "DISPATCH_OUTBOX_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(DispatchOutboxEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "AGENT_EVENT_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(AgentEventEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "AGENT_EVENT_CONFLICT_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(AgentEventConflictEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "RESULT_INBOX_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(ResultInboxEntity),
    inject: ["DATA_SOURCE"],
  },
  {
    provide: "RESULT_CONFLICT_REPOSITORY",
    useFactory: (dataSource: DataSource) =>
      dataSource.getRepository(ResultConflictEntity),
    inject: ["DATA_SOURCE"],
  },
];
