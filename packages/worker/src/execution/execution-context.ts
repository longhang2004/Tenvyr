import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { AgentExecutionError } from "../public/errors";
import type {
  AgentExecutionContext,
  AgentExecutionSuccess,
  AgentFailureOptions,
  WorkerLogger,
} from "../public/types";

const structuredSuccess = Symbol("TenvyrStructuredSuccess");

type BrandedSuccess<TOutput> = AgentExecutionSuccess<TOutput> & {
  [structuredSuccess]: true;
};

export function createExecutionContext(input: {
  invocation: AgentInvocationV1;
  runId: string;
  signal: AbortSignal;
  logger: WorkerLogger;
}): AgentExecutionContext {
  return {
    ...input,
    success<TOutput>(
      value: AgentExecutionSuccess<TOutput> = {},
    ): AgentExecutionSuccess<TOutput> {
      const result = { ...value } as BrandedSuccess<TOutput>;
      Object.defineProperty(result, structuredSuccess, { value: true });
      return result;
    },
    fail(options: AgentFailureOptions): never {
      throw new AgentExecutionError(options);
    },
  };
}

export function isStructuredSuccess<TOutput>(
  value: unknown,
): value is AgentExecutionSuccess<TOutput> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<BrandedSuccess<TOutput>>)[structuredSuccess] === true,
  );
}
