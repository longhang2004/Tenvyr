import { Injectable } from "@nestjs/common";
import type {
  ConditionExpression,
  ConditionLiteral,
  ConditionOperand,
} from "../domain/pipeline-definition";

const REFERENCE =
  /^(?:pipeline\.input|steps\.[a-zA-Z0-9_-]+\.(?:result|output|status|error|attempt))(?:\.[a-zA-Z0-9_-]+)*$/;
const MAX_CONDITION_DEPTH = 20;

@Injectable()
export class ConditionEvaluatorService {
  compile(condition: unknown): ConditionExpression {
    if (typeof condition === "string") return this.compileLegacy(condition);
    this.validateExpression(condition, "condition");
    return condition;
  }

  evaluate(expression: ConditionExpression, context: unknown): boolean {
    switch (expression.op) {
      case "and":
        return expression.conditions.every((item) =>
          this.evaluate(item, context),
        );
      case "or":
        return expression.conditions.some((item) =>
          this.evaluate(item, context),
        );
      case "not":
        return !this.evaluate(expression.condition, context);
      case "exists":
        return this.resolve(expression.value, context) !== undefined;
      case "in": {
        const value = this.resolve(expression.value, context);
        const values = Array.isArray(expression.values)
          ? expression.values.map((item) => this.resolve(item, context))
          : this.resolve(expression.values, context);
        return Array.isArray(values) && values.includes(value);
      }
      default: {
        const left = this.resolve(expression.left, context);
        const right = this.resolve(expression.right, context);
        switch (expression.op) {
          case "eq":
            return left === right;
          case "ne":
            return left !== right;
          case "gt":
            return this.comparable(left, right) && left > right;
          case "gte":
            return this.comparable(left, right) && left >= right;
          case "lt":
            return this.comparable(left, right) && left < right;
          case "lte":
            return this.comparable(left, right) && left <= right;
        }
      }
    }
  }

  private compileLegacy(condition: string): ConditionExpression {
    const unwrapped =
      condition.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/)?.[1] ?? condition;
    const match = unwrapped.match(
      /^\s*([^\s]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+?)\s*$/,
    );
    if (!match) {
      throw new Error(
        "Legacy condition must be one comparison between a supported reference and a literal/reference",
      );
    }

    const operators: Record<string, ConditionExpression["op"]> = {
      "===": "eq",
      "==": "eq",
      "!==": "ne",
      "!=": "ne",
      ">": "gt",
      ">=": "gte",
      "<": "lt",
      "<=": "lte",
    };
    const expression = {
      op: operators[match[2]],
      left: this.parseLegacyOperand(match[1]),
      right: this.parseLegacyOperand(match[3]),
    } as ConditionExpression;
    this.validateExpression(expression, "condition");
    return expression;
  }

  private parseLegacyOperand(value: string): ConditionOperand {
    const trimmed = value.trim();
    if (REFERENCE.test(trimmed)) return { ref: trimmed };
    if (/^'(?:[^'\\]|\\.)*'$/.test(trimmed)) {
      return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed === null ||
        ["string", "number", "boolean"].includes(typeof parsed)
      ) {
        return parsed as ConditionLiteral;
      }
    } catch {
      // The error below deliberately avoids accepting executable expressions.
    }
    throw new Error(`Unsupported legacy condition operand: ${trimmed}`);
  }

  private validateExpression(
    value: unknown,
    path: string,
    depth = 1,
  ): asserts value is ConditionExpression {
    if (depth > MAX_CONDITION_DEPTH)
      throw new Error(`Condition exceeds depth ${MAX_CONDITION_DEPTH}`);
    if (!this.isRecord(value) || typeof value.op !== "string") {
      throw new Error(`${path} must be a declarative condition object`);
    }
    if (value.op === "and" || value.op === "or") {
      if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
        throw new Error(`${path}.conditions must be a non-empty array`);
      }
      value.conditions.forEach((item, index) =>
        this.validateExpression(
          item,
          `${path}.conditions[${index}]`,
          depth + 1,
        ),
      );
      return;
    }
    if (value.op === "not") {
      this.validateExpression(value.condition, `${path}.condition`, depth + 1);
      return;
    }
    if (value.op === "exists") {
      this.validateOperand(value.value, `${path}.value`);
      return;
    }
    if (value.op === "in") {
      this.validateOperand(value.value, `${path}.value`);
      if (Array.isArray(value.values)) {
        if (value.values.length === 0)
          throw new Error(`${path}.values must not be empty`);
        value.values.forEach((item, index) =>
          this.validateOperand(item, `${path}.values[${index}]`),
        );
      } else {
        this.validateReference(value.values, `${path}.values`);
      }
      return;
    }
    if (["eq", "ne", "gt", "gte", "lt", "lte"].includes(value.op)) {
      this.validateOperand(value.left, `${path}.left`);
      this.validateOperand(value.right, `${path}.right`);
      return;
    }
    throw new Error(`${path}.op is not supported`);
  }

  private validateOperand(
    value: unknown,
    path: string,
  ): asserts value is ConditionOperand {
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    )
      return;
    this.validateReference(value, path);
  }

  private validateReference(
    value: unknown,
    path: string,
  ): asserts value is { ref: string } {
    if (
      !this.isRecord(value) ||
      typeof value.ref !== "string" ||
      !REFERENCE.test(value.ref)
    ) {
      throw new Error(`${path} must be a supported context reference`);
    }
  }

  private resolve(operand: ConditionOperand, context: unknown): unknown {
    if (!this.isRecord(operand) || !("ref" in operand)) return operand;
    let current: unknown = context;
    for (const part of operand.ref.split(".")) {
      if (!this.isRecord(current)) return undefined;
      current = current[part];
    }
    return current;
  }

  private comparable(left: unknown, right: unknown): left is string | number {
    return (
      (typeof left === "number" && typeof right === "number") ||
      (typeof left === "string" && typeof right === "string")
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}
