import type { AgentFailureOptions } from "./types";
import { asJsonValue } from "../execution/json-value";

export class AgentExecutionError extends Error {
  readonly failure: AgentFailureOptions;

  constructor(failure: AgentFailureOptions) {
    if (!failure.code?.trim())
      throw new TypeError("Agent failure code must be a non-empty string");
    if (!failure.message?.trim())
      throw new TypeError("Agent failure message must be a non-empty string");
    if (typeof failure.retryable !== "boolean")
      throw new TypeError("Agent failure retryable must be boolean");
    if (failure.details !== undefined) asJsonValue(failure.details);
    super(failure.message);
    this.name = "AgentExecutionError";
    this.failure = failure;
  }
}
