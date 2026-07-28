import Ajv2020, { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  agentEventV1Schema,
  agentInvocationV1Schema,
  agentResultV1Schema,
  httpAgentRunAcceptedV1Schema,
  httpAgentRunRequestV1Schema,
} from "./schemas";
import { HttpAgentRunAcceptedV1, HttpAgentRunRequestV1 } from "./http-types";
import { AgentEventV1, AgentInvocationV1, AgentResultV1 } from "./types";

export type ContractValidationIssue = {
  path: string;
  message: string;
  keyword?: string;
};

export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: ContractValidationIssue[];

  constructor(contract: string, issues: ContractValidationIssue[]) {
    super(
      `${contract} validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    );
    this.name = "ContractValidationError";
    this.contract = contract;
    this.issues = issues;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const invocationValidator = ajv.compile(agentInvocationV1Schema);
const resultValidator = ajv.compile(agentResultV1Schema);
const eventValidator = ajv.compile(agentEventV1Schema);
const httpRunRequestValidator = ajv.compile(httpAgentRunRequestV1Schema);
const httpRunAcceptedValidator = ajv.compile(httpAgentRunAcceptedV1Schema);

function issuePath(error: ErrorObject): string {
  if (error.keyword === "required") {
    return `${error.instancePath}/${String(error.params.missingProperty)}`;
  }
  if (error.keyword === "additionalProperties") {
    return `${error.instancePath}/${String(error.params.additionalProperty)}`;
  }
  return error.instancePath || "/";
}

function validate<T>(
  contract: string,
  validator: ValidateFunction,
  value: unknown,
): T {
  const numericIssue = findInvalidNumber(value);
  if (numericIssue) {
    throw new ContractValidationError(contract, [numericIssue]);
  }
  if (!validator(value)) {
    throw new ContractValidationError(
      contract,
      (validator.errors || []).map((error) => ({
        path: issuePath(error),
        message: error.message || "is invalid",
        keyword: error.keyword,
      })),
    );
  }
  return value as T;
}

function findInvalidNumber(
  value: unknown,
  path = "",
  seen = new Set<object>(),
): ContractValidationIssue | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return {
        path: path || "/",
        message: "must be a finite JSON number",
        keyword: "semantic",
      };
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return {
        path: path || "/",
        message: "must be a safe JSON integer",
        keyword: "semantic",
      };
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      const issue = findInvalidNumber(
        child,
        `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        seen,
      );
      if (issue) return issue;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

export function parseAgentInvocation(value: unknown): AgentInvocationV1 {
  return validate<AgentInvocationV1>(
    "AgentInvocationV1",
    invocationValidator,
    value,
  );
}

export function parseAgentResult(value: unknown): AgentResultV1 {
  const result = validate<AgentResultV1>(
    "AgentResultV1",
    resultValidator,
    value,
  );
  const invalidSucceededResult = result.status === "succeeded" && result.error;
  const invalidFailedResult = result.status !== "succeeded" && !result.error;
  if (invalidSucceededResult || invalidFailedResult) {
    throw new ContractValidationError("AgentResultV1", [
      {
        path: "/error",
        message:
          result.status === "succeeded"
            ? "must be absent when status is succeeded"
            : "is required",
        keyword: "semantic",
      },
    ]);
  }
  return result;
}

export function parseAgentEvent(value: unknown): AgentEventV1 {
  return validate<AgentEventV1>("AgentEventV1", eventValidator, value);
}

export function parseHttpAgentRunRequest(
  value: unknown,
): HttpAgentRunRequestV1 {
  return validate<HttpAgentRunRequestV1>(
    "HttpAgentRunRequestV1",
    httpRunRequestValidator,
    value,
  );
}

export function parseHttpAgentRunAccepted(
  value: unknown,
): HttpAgentRunAcceptedV1 {
  return validate<HttpAgentRunAcceptedV1>(
    "HttpAgentRunAcceptedV1",
    httpRunAcceptedValidator,
    value,
  );
}
