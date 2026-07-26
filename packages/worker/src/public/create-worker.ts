import type { AgentWeaveWorker, AgentWeaveWorkerConfig } from "./types";
import { parseWorkerConfig } from "../config/worker-config.validation";
import { AgentWeaveWorkerRuntime } from "../lifecycle/worker-lifecycle";
import { noOpLogger, safeLogger } from "../observability/safe-logger";

export function createAgentWeaveWorker<TInput = unknown, TOutput = unknown>(
  config: AgentWeaveWorkerConfig<TInput, TOutput>,
): AgentWeaveWorker {
  const parsed = parseWorkerConfig(config);
  return new AgentWeaveWorkerRuntime({
    ...parsed,
    logger: safeLogger(parsed.logger ?? noOpLogger),
  });
}
