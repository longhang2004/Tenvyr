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
  /** M4: optional per-attempt reservation maxima in canonical budget units. */
  budget?: Partial<Record<"currency_micros" | "tokens" | "wall_time_ms", number>>;

  /** M5-S3: marks this step as a supervised Planner step — its result
   *  output must be a bounded PlanPatch, which the orchestrator persists
   *  as a PENDING proposal (never execution authority). */
  planner?: true;

  /** M6-S1: how this step's native runtime delegation is treated:
   *  "opaque" (default — no invented lineage) or "observed" (bounded
   *  runtime-asserted evidence is recorded; it never schedules, spends,
   *  cancels, or terminalizes). "supervised" arrives with M6-S2+. */
  delegation?: "opaque" | "observed";
};

export type PipelineDefinition = {
  name: string;
  version: string;
  description?: string;
  /** M4: optional execution-level budget grant envelope (parent scope +
   *  dimension ceilings). */
  budget?: {
    parent?: { scopeType: string; scopeId: string };
  } & Partial<Record<"currency_micros" | "tokens" | "wall_time_ms", number>>;
  steps: PipelineStepConfig[];
};
