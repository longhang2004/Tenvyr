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
 * Identifies the final assistant event and extracts its text/payload.
 */
function adaptCodexOutput(stdout: string, agent: string): NativeOutputResult {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastAssistantText: string | null = null;
  let lastAssistantJson: unknown = null;

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

    // Inspect known Codex event patterns:
    // 1. { type: "item.completed", item: { role: "assistant", content: [{ text: "..." }] } }
    // 2. { type: "message.completed", message: { role: "assistant", content: "..." } }
    // 3. { type: "response.done", response: { output: [{ role: "assistant", ... }] } }
    // 4. { role: "assistant", content: "..." }
    // 5. { type: "turn.completed", text: "..." }
    // 6. Direct JSON object if single-line
    if (lines.length === 1 && !event.type && !event.role) {
      lastAssistantJson = event;
      break;
    }

    const role = event.role ?? (event.item as any)?.role ?? (event.message as any)?.role;
    if (role === "assistant" || event.type === "turn.completed" || event.type === "agent_message") {
      const extracted = extractTextFromPayload(event);
      if (extracted !== null) {
        lastAssistantText = extracted;
      }
    } else if (event.type === "response.done" && (event.response as any)?.output) {
      const outputList = (event.response as any).output;
      if (Array.isArray(outputList)) {
        for (const out of outputList) {
          if (out?.role === "assistant") {
            const extracted = extractTextFromPayload(out);
            if (extracted !== null) lastAssistantText = extracted;
          }
        }
      }
    }
  }

  if (lastAssistantJson !== null) {
    return { success: true, output: lastAssistantJson };
  }

  if (lastAssistantText === null) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `Codex stream from "${agent}" did not emit a final assistant output event`,
      retryable: false,
    };
  }

  return parseFinalPayload(lastAssistantText, agent);
}

/**
 * OpenCode `opencode run --format json` emits JSON events.
 * Identifies the final assistant event and extracts its message payload.
 */
function adaptOpenCodeOutput(stdout: string, agent: string): NativeOutputResult {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let lastAssistantText: string | null = null;
  let lastAssistantJson: unknown = null;

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

    if (lines.length === 1 && !event.type && !event.role) {
      lastAssistantJson = event;
      break;
    }

    const type = event.type;
    const role = event.role ?? (event.message as any)?.role;
    if (
      role === "assistant" ||
      type === "response" ||
      type === "turn_complete" ||
      type === "final" ||
      type === "message"
    ) {
      const extracted = extractTextFromPayload(event);
      if (extracted !== null) {
        lastAssistantText = extracted;
      }
    }
  }

  if (lastAssistantJson !== null) {
    return { success: true, output: lastAssistantJson };
  }

  if (lastAssistantText === null) {
    return {
      success: false,
      code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
      message: `OpenCode stream from "${agent}" did not emit a final assistant output event`,
      retryable: false,
    };
  }

  return parseFinalPayload(lastAssistantText, agent);
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
