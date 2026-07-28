import type { AgentDefinition } from "./types";

export function defineAgent<TInput = unknown, TOutput = unknown>(
  definition: AgentDefinition<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
  return definition;
}
