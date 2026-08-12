import type { PipelineStepConfig } from "./pipeline-definition";

/**
 * M5-S1: the restricted PlanPatch contract. A Planner may propose bounded
 * mutations to an execution's UNSTARTED work: `addStep` appends a new
 * step, `replaceUnfrozenStep` swaps a complete step config for a step that
 * is not frozen (running/completed attempts or a claimed decision). No
 * merge/JSON Patch, no removal/rename/reorder, no full-plan replacement.
 * Application is deterministic and the whole candidate plan is re-validated
 * through the existing safe pipeline validation before it may activate.
 */

export const PLAN_PATCH_BOUNDS = {
  maxOperations: 20,
  maxSerializedBytes: 65_536,
  maxStepIdLength: 100,
  maxBaseRevision: 2_147_483_647,
} as const;

export type PlanPatchOperationV1 =
  | { op: "addStep"; step: unknown }
  | { op: "replaceUnfrozenStep"; stepId: string; step: unknown };

export type PlanPatchV1 = {
  schemaVersion: 1;
  baseRevision: number;
  operations: PlanPatchOperationV1[];
};

export class PlanPatchError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PATCH"
      | "TOO_MANY_OPERATIONS"
      | "PATCH_TOO_LARGE"
      | "BASE_REVISION_INVALID"
      | "INVALID_OPERATION"
      | "TARGET_NOT_FOUND"
      | "TARGET_FROZEN",
    message: string,
  ) {
    super(message);
    this.name = "PlanPatchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and bounds-checks an untrusted PlanPatch proposal. */
export function parsePlanPatch(value: unknown): PlanPatchV1 {
  if (!isRecord(value)) {
    throw new PlanPatchError("INVALID_PATCH", "PlanPatch must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new PlanPatchError(
      "INVALID_PATCH",
      `PlanPatch schemaVersion must be 1 (got ${String(value.schemaVersion)})`,
    );
  }
  const baseRevision = value.baseRevision;
  if (
    typeof baseRevision !== "number" ||
    !Number.isInteger(baseRevision) ||
    baseRevision < 1 ||
    baseRevision > PLAN_PATCH_BOUNDS.maxBaseRevision
  ) {
    throw new PlanPatchError(
      "BASE_REVISION_INVALID",
      `baseRevision must be a positive integer ≤ ${PLAN_PATCH_BOUNDS.maxBaseRevision}`,
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    PLAN_PATCH_BOUNDS.maxSerializedBytes
  ) {
    throw new PlanPatchError(
      "PATCH_TOO_LARGE",
      `PlanPatch exceeds ${PLAN_PATCH_BOUNDS.maxSerializedBytes} serialized bytes`,
    );
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new PlanPatchError(
      "INVALID_PATCH",
      "PlanPatch must contain at least one operation",
    );
  }
  if (value.operations.length > PLAN_PATCH_BOUNDS.maxOperations) {
    throw new PlanPatchError(
      "TOO_MANY_OPERATIONS",
      `PlanPatch exceeds ${PLAN_PATCH_BOUNDS.maxOperations} operations`,
    );
  }
  const operations: PlanPatchOperationV1[] = value.operations.map(
    (operation, index) => {
      if (!isRecord(operation)) {
        throw new PlanPatchError(
          "INVALID_OPERATION",
          `operations[${index}] must be an object`,
        );
      }
      if (operation.op === "addStep") {
        if (!isRecord(operation.step)) {
          throw new PlanPatchError(
            "INVALID_OPERATION",
            `operations[${index}].step must be an object`,
          );
        }
        return { op: "addStep", step: operation.step };
      }
      if (operation.op === "replaceUnfrozenStep") {
        const stepId = operation.stepId;
        if (
          typeof stepId !== "string" ||
          stepId.length === 0 ||
          stepId.length > PLAN_PATCH_BOUNDS.maxStepIdLength
        ) {
          throw new PlanPatchError(
            "INVALID_OPERATION",
            `operations[${index}].stepId must be a bounded identifier string`,
          );
        }
        if (!isRecord(operation.step)) {
          throw new PlanPatchError(
            "INVALID_OPERATION",
            `operations[${index}].step must be an object`,
          );
        }
        if (operation.step.id !== stepId) {
          throw new PlanPatchError(
            "INVALID_OPERATION",
            `operations[${index}].step.id must equal stepId (${String(stepId)})`,
          );
        }
        return {
          op: "replaceUnfrozenStep",
          stepId,
          step: operation.step,
        };
      }
      throw new PlanPatchError(
        "INVALID_OPERATION",
        `operations[${index}].op must be addStep or replaceUnfrozenStep`,
      );
    },
  );
  return { schemaVersion: 1, baseRevision, operations };
}

/**
 * Deterministically applies the patch to the base steps. Additions append
 * in order; replacements swap the step in place. Every replace target must
 * exist in the candidate so far and must NOT be frozen. The returned
 * candidate is UNVALIDATED — the caller must run the full candidate
 * through the safe pipeline validation before activation.
 */
export function applyPlanPatch(
  baseSteps: readonly unknown[],
  frozenStepIds: ReadonlySet<string>,
  patch: PlanPatchV1,
): unknown[] {
  const candidate = [...baseSteps];
  for (const operation of patch.operations) {
    if (operation.op === "addStep") {
      candidate.push(operation.step);
      continue;
    }
    const index = candidate.findIndex(
      (step) => isRecord(step) && step.id === operation.stepId,
    );
    if (index === -1) {
      throw new PlanPatchError(
        "TARGET_NOT_FOUND",
        `replaceUnfrozenStep target "${operation.stepId}" does not exist in the candidate plan`,
      );
    }
    if (frozenStepIds.has(operation.stepId)) {
      throw new PlanPatchError(
        "TARGET_FROZEN",
        `replaceUnfrozenStep target "${operation.stepId}" is frozen`,
      );
    }
    candidate[index] = operation.step;
  }
  return candidate;
}
