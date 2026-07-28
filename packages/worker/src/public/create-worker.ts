import type { TenvyrWorker, TenvyrWorkerConfig } from "./types";
import { parseWorkerConfig } from "../config/worker-config.validation";
import { TenvyrWorkerRuntime } from "../lifecycle/worker-lifecycle";
import { noOpLogger, safeLogger } from "../observability/safe-logger";

export function createTenvyrWorker<TInput = unknown, TOutput = unknown>(
  config: TenvyrWorkerConfig<TInput, TOutput>,
): TenvyrWorker {
  const parsed = parseWorkerConfig(config);
  return new TenvyrWorkerRuntime({
    ...parsed,
    logger: safeLogger(parsed.logger ?? noOpLogger),
  });
}
