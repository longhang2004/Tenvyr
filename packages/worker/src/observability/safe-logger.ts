import type { WorkerLogger } from "../public/types";

const ignore = (): void => undefined;

export const noOpLogger: WorkerLogger = {
  debug: ignore,
  info: ignore,
  warn: ignore,
  error: ignore,
};

export function safeLogger(logger: WorkerLogger): WorkerLogger {
  const invoke =
    (level: keyof WorkerLogger) =>
    (message: string, context?: Record<string, unknown>): void => {
      try {
        const outcome = (
          logger[level] as (
            message: string,
            context?: Record<string, unknown>,
          ) => unknown
        )(message, context);
        if (
          outcome &&
          (typeof outcome === "object" || typeof outcome === "function") &&
          typeof (outcome as PromiseLike<unknown>).then === "function"
        ) {
          void Promise.resolve(outcome).catch(ignore);
        }
      } catch {
        // Logging is an observation boundary and must never change execution or delivery.
      }
    };
  return {
    debug: invoke("debug"),
    info: invoke("info"),
    warn: invoke("warn"),
    error: invoke("error"),
  };
}

export function runLogger(
  logger: WorkerLogger,
  context: Record<string, string | number>,
): WorkerLogger {
  const safe = safeLogger(logger);
  return {
    debug: (message, extra) => safe.debug(message, { ...context, ...extra }),
    info: (message, extra) => safe.info(message, { ...context, ...extra }),
    warn: (message, extra) => safe.warn(message, { ...context, ...extra }),
    error: (message, extra) => safe.error(message, { ...context, ...extra }),
  };
}
