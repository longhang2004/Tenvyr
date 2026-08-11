import { Injectable } from "@nestjs/common";
import { validateContextProjection } from "../domain/context-snapshot";
import { validateStateWrites } from "../domain/state-writes";
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

    const contextProjection =
      value.contextProjection === undefined
        ? undefined
        : validateContextProjection(value.contextProjection);

    const stateWrites =
      value.stateWrites === undefined
        ? undefined
        : validateStateWrites(value.stateWrites);

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
      ...(contextProjection === undefined ? {} : { contextProjection }),
      ...(stateWrites === undefined ? {} : { stateWrites }),
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

    // M2D: every artifact selector's fromStep must be a declared TRANSITIVE
    // dependency of the consumer step; self, unrelated, and future steps are
    // rejected at pipeline ingress.
    for (const step of steps) {
      for (const selector of step.contextProjection?.artifacts ?? []) {
        if (selector.fromStep === step.id) {
          throw new Error(
            `Step ${step.id} cannot project artifacts from itself`,
          );
        }
        if (!this.isTransitiveDependency(step, selector.fromStep, byId)) {
          throw new Error(
            `Step ${step.id} projects artifacts from ${selector.fromStep}, which is not a transitive dependency`,
          );
        }
      }
    }

    // M2E static write-conflict rule: two steps that may run concurrently
    // cannot write the same ExecutionState key. Same-key writers are allowed
    // only when the DAG proves one is transitively ordered before the other
    // (dependency reachability establishes sequence). Disjoint parallel
    // writes remain allowed and commute under the execution row lock.
    const writers = new Map<string, string[]>();
    for (const step of steps) {
      for (const mapping of step.stateWrites ?? []) {
        const list = writers.get(mapping.key) ?? [];
        list.push(step.id);
        writers.set(mapping.key, list);
      }
    }
    for (const [key, ids] of writers) {
      for (let first = 0; first < ids.length; first += 1) {
        for (let second = first + 1; second < ids.length; second += 1) {
          const writerA = byId.get(ids[first])!;
          const writerB = byId.get(ids[second])!;
          const ordered =
            this.isTransitiveDependency(writerA, writerB.id, byId) ||
            this.isTransitiveDependency(writerB, writerA.id, byId);
          if (!ordered) {
            throw new Error(
              `Steps ${ids[first]} and ${ids[second]} both write state key "${key}" without proven ordering`,
            );
          }
        }
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

  private isTransitiveDependency(
    step: PipelineStepConfig,
    candidate: string,
    byId: Map<string, PipelineStepConfig>,
  ): boolean {
    const visit = (current: PipelineStepConfig, seen: Set<string>): boolean => {
      for (const dependency of current.dependsOn ?? []) {
        if (dependency === candidate) return true;
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        const next = byId.get(dependency);
        if (next && visit(next, seen)) return true;
      }
      return false;
    };
    return visit(step, new Set([step.id]));
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
