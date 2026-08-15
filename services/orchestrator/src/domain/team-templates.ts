import type { CoordinationConfigV1 } from "./coordination";

/**
 * Product Phase 1: bounded team templates. Templates define ROLES, useful
 * bounds, and goal-framing metadata ONLY — the Planner still proposes the
 * actual TaskBatch, and Tenvyr still authorizes it. Worker intelligence is
 * never hardcoded here.
 */

export type TeamTemplateV1 = {
  templateId: "software-engineering" | "code-review";
  name: string;
  description: string;
  /** Suggested goal framing appended to the operator's goal. */
  goalFraming: string;
  /** Suggested bounds (operator may tighten; never silently raised). */
  defaultBounds: {
    maxIterations: number;
    maxWorkersPerIteration: number;
    maxTotalWorkers: number;
    loopDeadlineMs: number;
    delegationDepthMax: number;
  };
  /** Role suggestions: the operator selects the actual connections. */
  roleSuggestions: {
    planner: { kind: "connection" | "agent"; name: string };
    verifier: { kind: "connection" | "agent"; name: string };
    workerAgents: string[];
  };
};

export const TEAM_TEMPLATES: readonly TeamTemplateV1[] = [
  {
    templateId: "software-engineering",
    name: "Software Engineering",
    description:
      "Planner decomposes the goal; Workers implement/test/review as proposed; Verifier checks objective + evidence.",
    goalFraming:
      " Plan the work as a bounded task batch, implement with evidence, and do not finish until the verifier accepts or limits are exhausted.",
    defaultBounds: {
      maxIterations: 3,
      maxWorkersPerIteration: 4,
      maxTotalWorkers: 12,
      loopDeadlineMs: 60 * 60 * 1000,
      delegationDepthMax: 1,
    },
    roleSuggestions: {
      planner: { kind: "connection", name: "" },
      verifier: { kind: "connection", name: "" },
      workerAgents: ["implementation"],
    },
  },
  {
    templateId: "code-review",
    name: "Code Review",
    description:
      "Planner scopes the review surface; parallel review workers; Verifier decides.",
    goalFraming:
      " Review the selected repository surface for correctness, security, and maintainability, and do not finish until the verifier accepts or limits are exhausted.",
    defaultBounds: {
      maxIterations: 2,
      maxWorkersPerIteration: 3,
      maxTotalWorkers: 6,
      loopDeadlineMs: 45 * 60 * 1000,
      delegationDepthMax: 1,
    },
    roleSuggestions: {
      planner: { kind: "connection", name: "" },
      verifier: { kind: "connection", name: "" },
      workerAgents: ["review"],
    },
  },
];

/** Builds a CoordinationConfigV1 skeleton from a template. Selections are
 *  left for the operator (planner/verifier names empty = must fill);
 *  allowedWorkers starts empty (the operator adds worker connections).
 *  Bounds come from the template defaults and can only be tightened. */
export function configFromTeamTemplate(
  templateId: TeamTemplateV1["templateId"],
  overrides: Partial<
    Pick<
      CoordinationConfigV1,
      "maxIterations" | "maxWorkersPerIteration" | "maxTotalWorkers" | "loopDeadlineMs"
    >
  > = {},
): CoordinationConfigV1 {
  const template = TEAM_TEMPLATES.find(
    (candidate) => candidate.templateId === templateId,
  );
  if (!template) {
    throw new Error(`unknown team template "${templateId}"`);
  }
  const defaults = template.defaultBounds;
  return {
    schemaVersion: 1,
    planner: { kind: "connection", name: "" },
    verifier: { kind: "connection", name: "" },
    allowedWorkers: [],
    maxIterations: overrides.maxIterations ?? defaults.maxIterations,
    maxWorkersPerIteration:
      overrides.maxWorkersPerIteration ?? defaults.maxWorkersPerIteration,
    maxTotalWorkers: overrides.maxTotalWorkers ?? defaults.maxTotalWorkers,
    loopDeadlineMs: overrides.loopDeadlineMs ?? defaults.loopDeadlineMs,
    delegationDepthMax: defaults.delegationDepthMax,
    allowedExecutors: ["local-host"],
  };
}
