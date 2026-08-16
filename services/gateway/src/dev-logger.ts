/**
 * Tenvyr development logger (bounded Nest LoggerService).
 *
 * Presentation-only: this file changes TERMINAL presentation in
 * development, never production logging semantics. Production
 * (NODE_ENV=production) keeps Nest's full console logger untouched.
 *
 * Modes:
 *   normal  (default in development) — low-signal Nest bootstrap contexts
 *           (RouterExplorer / RoutesResolver / InstanceLoader /
 *           NestFactory / NestApplication) are suppressed; WARN/ERROR and
 *           application-domain logs ALWAYS survive.
 *   verbose (TENVYR_LOG_LEVEL=verbose) — every framework line is emitted.
 *
 * Colors: semantic and restrained (INFO neutral, WARN yellow, ERROR red,
 * DEBUG dim), gated on an interactive stdout. NO_COLOR disables, and
 * FORCE_COLOR=1 enables, per conventional behavior.
 */
import { LoggerService } from "@nestjs/common";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "gateway";

export type TenvyrLogMode = "normal" | "verbose";

export function detectLogMode(env: NodeJS.ProcessEnv = process.env): TenvyrLogMode {
  const explicit = env.TENVYR_LOG_LEVEL;
  if (explicit === "verbose") return "verbose";
  if (explicit === "normal") return "normal";
  if (env.NODE_ENV === "production") return "verbose";
  return "normal";
}

/** Low-signal Nest bootstrap contexts suppressed in NORMAL mode. */
const LOW_SIGNAL_CONTEXTS = new Set([
  "RouterExplorer",
  "RoutesResolver",
  "InstanceLoader",
  "NestFactory",
  "NestApplication",
]);

/** Pure predicate: should this (context, level) line be emitted? */
export function shouldEmitLogLine(
  context: string | undefined,
  level: "log" | "warn" | "error" | "debug" | "verbose",
  mode: TenvyrLogMode,
): boolean {
  if (mode === "verbose") return true;
  if (level === "warn" || level === "error") return true;
  if (level === "debug" || level === "verbose") return false;
  // INFO ("log"): suppress only known low-signal framework contexts.
  return !(context && LOW_SIGNAL_CONTEXTS.has(context));
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
};

function useColor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR === "1" || env.FORCE_COLOR === "true") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  return Boolean(process.stdout.isTTY);
}

function levelColor(level: string, color: boolean): string {
  if (!color) return "";
  switch (level) {
    case "WARN":
      return ANSI.yellow;
    case "ERROR":
      return ANSI.red;
    case "DEBUG":
    case "TRACE":
      return ANSI.dim;
    default:
      return "";
  }
}

function now(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Central compact line formatter: time service level message. */
export function formatDevLine(input: {
  time?: string;
  service: string;
  level: string;
  message: string;
  color?: boolean;
}): string {
  const color = input.color ?? useColor();
  const time = input.time ?? now();
  const service = input.service.padEnd(11, " ");
  const level = input.level.padEnd(5, " ");
  const levelText = color ? `${levelColor(input.level, true)}${level}${ANSI.reset}` : level;
  const message = String(input.message);
  const firstBreak = message.indexOf("\n");
  const single = firstBreak === -1 ? message : `${message.slice(0, firstBreak)} …`;
  return color
    ? `${ANSI.dim}${time}${ANSI.reset}  ${service}  ${levelText}  ${single}`
    : `${time}  ${service}  ${level}  ${single}`;
}

export class TenvyrDevLogger implements LoggerService {
  private readonly mode: TenvyrLogMode;
  private readonly color: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mode = detectLogMode(env);
    this.color = useColor(env);
  }

  log(message: unknown, context?: string) {
    if (!shouldEmitLogLine(context, "log", this.mode)) return;
    this.write("INFO", message, context);
  }

  warn(message: unknown, context?: string) {
    if (!shouldEmitLogLine(context, "warn", this.mode)) return;
    this.write("WARN", message, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string) {
    if (!shouldEmitLogLine(context, "error", this.mode)) return;
    // Nest passes (message, stack, context) — an error must NEVER be
    // reduced to an empty line. The stack (or its first line) is the
    // cause when the message is empty; verbose keeps the whole stack.
    const ctx = context !== undefined ? context : stackOrContext;
    const stack = context !== undefined ? stackOrContext : undefined;
    const text = String(message ?? "");
    const cause = stack && stack !== text ? stack : undefined;
    const detail = text || (cause ? cause.split("\n")[0] : "") || "unknown error";
    this.write("ERROR", detail, ctx);
    // An error must carry its cause: emit up to a bounded number of stack
    // lines as separate ERROR lines (collapsing them hides the failure).
    if (cause && this.mode === "verbose") {
      for (const line of cause.split("\n").slice(0, 6)) {
        if (line.trim()) {
          process.stdout.write(
            formatDevLine({ service: SERVICE_NAME, level: "ERROR", message: line, color: this.color }) +
              "\n",
          );
        }
      }
    }
  }

  debug(message: unknown, context?: string) {
    if (!shouldEmitLogLine(context, "debug", this.mode)) return;
    this.write("DEBUG", message, context);
  }

  verbose(message: unknown, context?: string) {
    if (!shouldEmitLogLine(context, "verbose", this.mode)) return;
    this.write("TRACE", message, context);
  }

  private write(level: string, message: unknown, context?: string) {
    const text = String(message ?? "");
    const withContext = context ? `${text}${text ? " · " : ""}[${context}]` : text;
    process.stdout.write(
      formatDevLine({
        service: SERVICE_NAME,
        level,
        message: withContext,
        color: this.color,
      }) + "\n",
    );
  }
}
