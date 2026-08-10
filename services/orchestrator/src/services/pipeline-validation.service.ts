import { Injectable } from "@nestjs/common";
import type {
  FailurePolicy,
  PipelineDefinition,
  PipelineStepConfig,
} from "../domain/pipeline-definition";
import { ConditionEvaluatorService } from "./condition-evaluator.service";

const MAX_STEPS = 100;
const MAX_DEPTH = 20;
const MAX_FANOUT = 20;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

@Injectable()
export class PipelineValidationService {
  constructor(private readonly conditions: ConditionEvaluatorService) {}

  validate(input: unknown): PipelineDefinition {
    if (!this.isRecord(input)) throw new Error("Pipeline must be an object");
    const name = this.nonEmptyString(input.name, "name", 255);
    const version = this.nonEmptyString(input.version, "version", 50);
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new Error("Pipeline must contain at least one step");
    }
    if (input.steps.length > MAX_STEPS)
      throw new Error(`Pipeline exceeds ${MAX_STEPS} steps`);

    const steps = input.steps.map((step, index) =>
      this.validateStep(step, index),
    );
    this.validateGraph(steps);
    return {
      name,
      version,
      description:
        input.description === undefined || input.description === null
          ? undefined
          : this.nonEmptyString(input.description, "description", 10_000, true),
      steps,
    };
  }

  private validateStep(value: unknown, index: number): PipelineStepConfig {
    if (!this.isRecord(value))
      throw new Error(`steps[${index}] must be an object`);
    const id = this.nonEmptyString(value.id, `steps[${index}].id`, 100);
    if (!IDENTIFIER.test(id))
      throw new Error(`steps[${index}].id is not a valid identifier`);
    const agent = this.nonEmptyString(
      value.agent,
      `steps[${index}].agent`,
      100,
    );
    const dependsOn =
      value.dependsOn === undefined
        ? undefined
        : this.stringArray(value.dependsOn, `steps[${index}].dependsOn`);
    const retries =
      value.retries === undefined ? undefined : Number(value.retries);
    if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
      throw new Error(`steps[${index}].retries must be a non-negative integer`);
    }
    if (
      value.onFailure !== undefined &&
      !["continue", "stop", "retry"].includes(String(value.onFailure))
    ) {
      throw new Error(`steps[${index}].onFailure is not supported`);
    }
    if (value.timeout !== undefined && !this.validDuration(value.timeout)) {
      throw new Error(`steps[${index}].timeout must be a positive duration`);
    }
    if (value.input !== undefined && !this.isRecord(value.input)) {
      throw new Error(`steps[${index}].input must be an object`);
    }
    if (value.metadata !== undefined && !this.isRecord(value.metadata)) {
      throw new Error(`steps[${index}].metadata must be an object`);
    }

    return {
      id,
      agent,
      ...(value.input === undefined
        ? {}
        : { input: value.input as Record<string, unknown> }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(value.condition === undefined
        ? {}
        : { condition: this.conditions.compile(value.condition) }),
      ...(value.timeout === undefined
        ? {}
        : { timeout: value.timeout as string | number }),
      ...(retries === undefined ? {} : { retries }),
      ...(value.onFailure === undefined
        ? {}
        : { onFailure: value.onFailure as FailurePolicy }),
      ...(value.metadata === undefined
        ? {}
        : { metadata: value.metadata as Record<string, unknown> }),
    };
  }

  private validateGraph(steps: PipelineStepConfig[]): void {
    const byId = new Map<string, PipelineStepConfig>();
    for (const step of steps) {
      if (byId.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
      byId.set(step.id, step);
      if (
        step.dependsOn &&
        new Set(step.dependsOn).size !== step.dependsOn.length
      ) {
        throw new Error(`Step ${step.id} contains a duplicate dependency`);
      }
    }
    const fanout = new Map<string, number>();
    for (const step of steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!byId.has(dependency))
          throw new Error(
            `Step ${step.id} depends on missing step ${dependency}`,
          );
        fanout.set(dependency, (fanout.get(dependency) ?? 0) + 1);
        if (fanout.get(dependency)! > MAX_FANOUT)
          throw new Error(`Step ${dependency} exceeds fanout ${MAX_FANOUT}`);
      }
    }

    const visiting = new Set<string>();
    const depths = new Map<string, number>();
    const depth = (step: PipelineStepConfig): number => {
      const known = depths.get(step.id);
      if (known !== undefined) return known;
      if (visiting.has(step.id))
        throw new Error(`Pipeline contains a cycle at step ${step.id}`);
      visiting.add(step.id);
      const result =
        1 +
        Math.max(
          0,
          ...(step.dependsOn ?? []).map((id) => depth(byId.get(id)!)),
        );
      visiting.delete(step.id);
      if (result > MAX_DEPTH)
        throw new Error(`Pipeline exceeds graph depth ${MAX_DEPTH}`);
      depths.set(step.id, result);
      return result;
    };
    steps.forEach(depth);
  }

  private stringArray(value: unknown, path: string): string[] {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || !IDENTIFIER.test(item))
    ) {
      throw new Error(`${path} must contain valid step identifiers`);
    }
    return [...value];
  }

  private validDuration(value: unknown): boolean {
    return (
      (typeof value === "number" && Number.isFinite(value) && value > 0) ||
      (typeof value === "string" &&
        /^(?:\d+(?:\.\d+)?)(?:ms|s|m|h)?$/i.test(value.trim()) &&
        Number(value.match(/^\d+(?:\.\d+)?/)![0]) > 0)
    );
  }

  private nonEmptyString(
    value: unknown,
    path: string,
    max: number,
    allowEmpty = false,
  ): string {
    if (
      typeof value !== "string" ||
      (!allowEmpty && value.trim() === "") ||
      value.length > max
    ) {
      throw new Error(
        `${path} must be ${allowEmpty ? "a" : "a non-empty"} string no longer than ${max} characters`,
      );
    }
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}
