import type { HostAgentConfig } from "../config";
import type { ProcessOutcome } from "../supervisor";

/**
 * Bounded Native Runtime Output Adapter.
 *
 * Translates official native CLI outputs (Codex JSON Lines, OpenCode JSON
 * event streams, Claude JSON envelopes, Generic CLI) into validated Tenvyr
 * structured result payloads without owning LLM reasoning or session state.
 */

export type NativeOutputResult =
  | { success: true; output: unknown }
  | { success: false; code: string; message: string; retryable: boolean };

export function adaptNativeRuntimeOutput(
  outcome: ProcessOutcome,
  profile: HostAgentConfig,
): NativeOutputResult {
  if (outcome.kind !== "succeeded") {
    switch (outcome.kind) {
      case "failed":
        return {
          success: false,
          code: "EXECUTOR_HOST_PROCESS_FAILED",
          message:
            boundedTail(outcome.stderr, 1024) ||
            `Process exited with code ${outcome.exitCode}`,
          retryable: false,
        };
      case "spawn_failed":
        return {
          success: false,
          code: "EXECUTOR_HOST_SPAWN_FAILED",
          message: outcome.message,
          retryable: false,
        };
      case "killed":
        return {
          success: false,
          code:
            outcome.trigger === "shutdown"
              ? "EXECUTOR_HOST_SHUTDOWN"
              : "EXECUTOR_HOST_DEADLINE",
          message: `Process group ${outcome.finalSignal} after ${outcome.trigger}`,
          retryable: true,
        };
      case "output_limit":
        return {
          success: false,
          code: "EXECUTOR_HOST_OUTPUT_LIMIT",
          message: `${outcome.stream} exceeded the configured byte bound for agent "${profile.agent}"`,
          retryable: false,
        };
    }
  }

  if (!profile.structuredResult) {
    return {
      success: true,
      output: {
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
      },
    };
  }

  const rawStdout = outcome.stdout.trim();
  if (!rawStdout) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `Runtime "${profile.agent}" exited 0 but produced empty stdout`,
      retryable: false,
    };
  }

  const kind = profile.runtimeKind ?? "generic-cli";

  try {
    switch (kind) {
      case "codex":
        return adaptCodexOutput(rawStdout, profile.agent);
      case "opencode":
        return adaptOpenCodeOutput(rawStdout, profile.agent);
      case "claude":
        return adaptClaudeOutput(rawStdout, profile.agent);
      case "generic-cli":
      default:
        return adaptGenericCliOutput(rawStdout, profile.agent);
    }
  } catch (error) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `Failed to adapt native output for runtime "${profile.agent}" (${kind}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      retryable: false,
    };
  }
}

/**
 * Codex `codex exec --json` emits a JSON Lines stream.
 * Official contract:
 * - `thread.started`, `turn.started`
 * - `item.completed` with `item.type === "agent_message"` and `item.text: string` -> candidate assistant output
 * - `item.completed` with `item.type === "command_execution"` -> tool execution (ignored)
 * - `turn.completed` with `usage` -> turn metadata (ignored)
 * - fail closed on malformed JSONL or missing agent_message.
 */
function adaptCodexOutput(stdout: string, agent: string): NativeOutputResult {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastAgentMessageText: string | null = null;
  let singleDirectJson: unknown = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch (e) {
      return {
        success: false,
        code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
        message: `Codex stream line ${i + 1} from "${agent}" is not valid JSON: ${line.slice(0, 100)}`,
        retryable: false,
      };
    }

    if (lines.length === 1 && !event.type && !event.item) {
      singleDirectJson = event;
      break;
    }

    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (
        item &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        lastAgentMessageText = item.text;
      }
    }
  }

  if (singleDirectJson !== null) {
    return { success: true, output: singleDirectJson };
  }

  if (lastAgentMessageText === null) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `Codex stream from "${agent}" did not emit an item.completed agent_message event`,
      retryable: false,
    };
  }

  return parseFinalPayload(lastAgentMessageText, agent);
}

/**
 * OpenCode pinned v1.18.16 `opencode run --format json` emits JSON events:
 * - `step_start`, `step_finish`
 * - `tool_use`, `reasoning`, `error`
 * - `type === "text"` with `part.type === "text"` and `part.text: string`
 * - fail closed on malformed lines or missing text events.
 */
function adaptOpenCodeOutput(stdout: string, agent: string): NativeOutputResult {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastText: string | null = null;
  let singleDirectJson: unknown = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch (e) {
      return {
        success: false,
        code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
        message: `OpenCode event line ${i + 1} from "${agent}" is not valid JSON: ${line.slice(0, 100)}`,
        retryable: false,
      };
    }

    if (lines.length === 1 && !event.type && !event.part) {
      singleDirectJson = event;
      break;
    }

    if (event.type === "text") {
      const part = event.part as Record<string, unknown> | undefined;
      if (part && part.type === "text" && typeof part.text === "string") {
        lastText = part.text;
      }
    }
  }

  if (singleDirectJson !== null) {
    return { success: true, output: singleDirectJson };
  }

  if (lastText === null) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `OpenCode stream from "${agent}" did not emit a completed text event`,
      retryable: false,
    };
  }

  return parseFinalPayload(lastText, agent);
}

/**
 * Claude `claude -p --output-format json` emits a JSON envelope.
 */
function adaptClaudeOutput(stdout: string, agent: string): NativeOutputResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `Claude output from "${agent}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      retryable: false,
    };
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.result === "string") {
      return parseFinalPayload(obj.result, agent);
    }
    if (typeof obj.result === "object" && obj.result !== null) {
      return { success: true, output: obj.result };
    }
    if (typeof obj.output === "string") {
      return parseFinalPayload(obj.output, agent);
    }
    if (Array.isArray(obj.content)) {
      const textPart = obj.content.find((c: any) => c?.type === "text" && typeof c?.text === "string");
      if (textPart) {
        return parseFinalPayload(textPart.text, agent);
      }
    }
  }

  return { success: true, output: parsed };
}

/**
 * Generic CLI parses stdout as a single JSON document.
 */
function adaptGenericCliOutput(stdout: string, agent: string): NativeOutputResult {
  try {
    const parsed = JSON.parse(stdout);
    return { success: true, output: parsed };
  } catch (error) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `Structured result from "${agent}" is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      retryable: false,
    };
  }
}

function extractTextFromPayload(obj: Record<string, unknown>): string | null {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.output === "string") return obj.output;
  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  if (Array.isArray(obj.parts)) {
    const parts = obj.parts
      .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  if (obj.item && typeof obj.item === "object") {
    return extractTextFromPayload(obj.item as Record<string, unknown>);
  }
  if (obj.message && typeof obj.message === "object") {
    return extractTextFromPayload(obj.message as Record<string, unknown>);
  }
  return null;
}

function parseFinalPayload(text: string, agent: string): NativeOutputResult {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return { success: true, output: parsed };
  } catch {
    // If the assistant output is markdown fenced JSON: ```json\n{...}\n```
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        return { success: true, output: parsed };
      } catch {
        // Fall through
      }
    }
    return { success: true, output: { text: trimmed } };
  }
}

function boundedTail(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `...${value.slice(value.length - maxLength)}`;
}
