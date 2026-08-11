import type { ContextProjection } from "./context-snapshot";
import type { StateWriteMapping } from "./state-writes";

export type FailurePolicy = "continue" | "stop" | "retry";

export type ConditionLiteral = string | number | boolean | null;
export type ConditionOperand = ConditionLiteral | { ref: string };

export type ConditionExpression =
  | {
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      left: ConditionOperand;
      right: ConditionOperand;
    }
  | { op: "and" | "or"; conditions: ConditionExpression[] }
  | { op: "not"; condition: ConditionExpression }
  | { op: "exists"; value: ConditionOperand }
  | {
      op: "in";
      value: ConditionOperand;
      values: ConditionOperand[] | { ref: string };
    };

export type PipelineStepConfig = {
  id: string;
  agent: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  condition?: ConditionExpression;
  timeout?: string | number;
  retries?: number;
  onFailure?: FailurePolicy;
  metadata?: Record<string, unknown>;
  contextProjection?: ContextProjection;
  stateWrites?: StateWriteMapping[];
};

export type PipelineDefinition = {
  name: string;
  version: string;
  description?: string;
  steps: PipelineStepConfig[];
};
