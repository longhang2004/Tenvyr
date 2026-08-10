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
import { MilestoneZeroFoundation1722270000000 } from "./migrations/1722270000000-MilestoneZeroFoundation";
import { MilestoneOneAgentEvents1722270001000 } from "./migrations/1722270001000-MilestoneOneAgentEvents";

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
    ],
    migrations: [
      MilestoneZeroFoundation1722270000000,
      MilestoneOneAgentEvents1722270001000,
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
