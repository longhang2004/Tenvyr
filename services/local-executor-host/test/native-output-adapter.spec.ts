import { adaptNativeRuntimeOutput } from "../src/adapters/native-output-adapter";
import type { HostAgentConfig } from "../src/config";
import type { ProcessOutcome } from "../src/supervisor";

describe("NativeRuntimeOutputAdapter", () => {
  const baseProfile: HostAgentConfig = {
    agent: "test-agent",
    command: "/bin/true",
    args: [],
    cwd: "/tmp",
    env: {},
    secrets: {},
    wallTimeMs: 10_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 65_536,
    port: 4100,
    bearerTokenEnv: "TOKEN",
    structuredResult: true,
  };

  describe("Codex JSON Lines stream adapter", () => {
    const codexProfile: HostAgentConfig = {
      ...baseProfile,
      runtimeKind: "codex",
    };

    it("extracts TaskBatchProposal from official Codex item.completed agent_message event", () => {
      const proposal = {
        schemaVersion: 1,
        iterationNumber: 1,
        baseRevision: 1,
        tasks: [
          {
            taskId: "task-1",
            agent: "worker",
            reason: "Write code",
          },
        ],
        reason: "iteration 1",
      };
      const stdout = [
        JSON.stringify({ type: "thread.started", threadId: "th_123" }),
        JSON.stringify({ type: "turn.started", turnId: "turn_1" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "cmd_1",
            type: "command_execution",
            command: "git status",
            exitCode: 0,
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "msg_1",
            type: "agent_message",
            text: JSON.stringify(proposal),
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, codexProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual(proposal);
      }
    });

    it("uses the authoritative final agent_message when multiple exist", () => {
      const first = { intermediate: true };
      const final = {
        schemaVersion: 1,
        iterationNumber: 1,
        baseRevision: 1,
        tasks: [],
        reason: "final",
      };
      const stdout = [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "msg_1",
            type: "agent_message",
            text: JSON.stringify(first),
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "cmd_2",
            type: "command_execution",
            command: "ls -la",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "msg_2",
            type: "agent_message",
            text: JSON.stringify(final),
          },
        }),
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, codexProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual(final);
      }
    });

    it("handles markdown code block JSON from agent_message text", () => {
      const payload = { result: "completed", linesChanged: 42 };
      const stdout = [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "msg_1",
            type: "agent_message",
            text:
              "Here is the result:\n```json\n" +
              JSON.stringify(payload) +
              "\n```",
          },
        }),
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, codexProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual(payload);
      }
    });

    it("fails closed when Codex stream emits invalid JSON line", () => {
      const stdout = [
        JSON.stringify({ type: "thread.started" }),
        "not-valid-json-line",
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, codexProfile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("EXECUTOR_HOST_INVALID_STRUCTURED_RESULT");
        expect(result.message).toMatch(/is not valid JSON/);
      }
    });

    it("fails closed when Codex stream emits turn.completed usage without agent_message", () => {
      const stdout = [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "cmd_1",
            type: "command_execution",
            command: "git status",
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { inputTokens: 50, outputTokens: 10 },
        }),
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, codexProfile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("EXECUTOR_HOST_INVALID_STRUCTURED_RESULT");
        expect(result.message).toMatch(
          /did not emit an item.completed agent_message event/,
        );
      }
    });
  });

  describe("OpenCode JSON event adapter (pinned v1.18.16)", () => {
    const openCodeProfile: HostAgentConfig = {
      ...baseProfile,
      runtimeKind: "opencode",
    };

    it("extracts assistant payload from pinned OpenCode text part events", () => {
      const payload = { status: "success", files: ["src/index.ts"] };
      const stdout = [
        JSON.stringify({
          type: "step_start",
          timestamp: 1700000000,
          sessionID: "ses_1",
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: 1700000001,
          sessionID: "ses_1",
          tool: "bash",
        }),
        JSON.stringify({
          type: "reasoning",
          timestamp: 1700000002,
          sessionID: "ses_1",
          part: { type: "reasoning", text: "Thinking about files..." },
        }),
        JSON.stringify({
          type: "text",
          timestamp: 1700000003,
          sessionID: "ses_1",
          part: { type: "text", text: JSON.stringify(payload) },
        }),
        JSON.stringify({
          type: "step_finish",
          timestamp: 1700000004,
          sessionID: "ses_1",
        }),
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, openCodeProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual(payload);
      }
    });

    it("fails closed when OpenCode stream emits only step_start/tool_use/reasoning without text", () => {
      const stdout = [
        JSON.stringify({ type: "step_start", timestamp: 1700000000 }),
        JSON.stringify({
          type: "reasoning",
          part: { type: "reasoning", text: "Only thinking" },
        }),
        JSON.stringify({ type: "step_finish", timestamp: 1700000005 }),
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, openCodeProfile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("EXECUTOR_HOST_INVALID_STRUCTURED_RESULT");
        expect(result.message).toMatch(/did not emit a completed text event/);
      }
    });

    it("fails closed on malformed JSON in OpenCode stream", () => {
      const stdout = [
        JSON.stringify({ type: "step_start" }),
        "{ not valid json",
      ].join("\n");

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, openCodeProfile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("EXECUTOR_HOST_INVALID_STRUCTURED_RESULT");
        expect(result.message).toMatch(/is not valid JSON/);
      }
    });
  });

  describe("Claude JSON adapter", () => {
    const claudeProfile: HostAgentConfig = {
      ...baseProfile,
      runtimeKind: "claude",
    };

    it("extracts structured object from Claude result envelope", () => {
      const proposal = { tasks: [{ id: "t1", title: "Task 1" }] };
      const stdout = JSON.stringify({
        type: "result",
        result: JSON.stringify(proposal),
      });

      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, claudeProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual(proposal);
      }
    });
  });

  describe("Generic CLI & Unstructured output", () => {
    it("parses single JSON stdout for generic-cli", () => {
      const stdout = JSON.stringify({ ok: true, count: 5 });
      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout,
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, baseProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual({ ok: true, count: 5 });
      }
    });

    it("returns raw exitCode and stdout when structuredResult is false", () => {
      const rawProfile: HostAgentConfig = {
        ...baseProfile,
        structuredResult: false,
      };
      const outcome: ProcessOutcome = {
        kind: "succeeded",
        exitCode: 0,
        stdout: "plain text output\nline 2",
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, rawProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual({
          exitCode: 0,
          stdout: "plain text output\nline 2",
        });
      }
    });
  });

  describe("Process failure outcomes", () => {
    it("handles non-zero exit code", () => {
      const outcome: ProcessOutcome = {
        kind: "failed",
        exitCode: 2,
        stdout: "",
        stderr: "Command failed: file not found",
      };

      const result = adaptNativeRuntimeOutput(outcome, baseProfile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("EXECUTOR_HOST_PROCESS_FAILED");
        expect(result.message).toContain("Command failed");
      }
    });

    it("handles deadline kill", () => {
      const outcome: ProcessOutcome = {
        kind: "killed",
        trigger: "wall_time",
        finalSignal: "SIGKILL",
        stdout: "",
        stderr: "",
      };

      const result = adaptNativeRuntimeOutput(outcome, baseProfile);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("EXECUTOR_HOST_DEADLINE");
        expect(result.retryable).toBe(true);
      }
    });
  });
});
