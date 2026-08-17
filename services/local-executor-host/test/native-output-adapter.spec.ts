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

    it("extracts TaskBatchProposal from Codex event stream", () => {
      const proposal = {
        tasks: [
          {
            id: "task-1",
            title: "Implement feature",
            agent: "worker",
            description: "Write code",
          },
        ],
      };
      const stdout = [
        JSON.stringify({ type: "session.started", sessionId: "sess-1" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify(proposal) }],
          },
        }),
        JSON.stringify({ type: "turn.completed" }),
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

    it("extracts VerifierDecision from Codex response.done output", () => {
      const decision = {
        decision: "ACCEPT",
        reason: "All checks passed",
      };
      const stdout = [
        JSON.stringify({ type: "init" }),
        JSON.stringify({
          type: "response.done",
          response: {
            output: [
              {
                role: "assistant",
                content: [{ type: "text", text: JSON.stringify(decision) }],
              },
            ],
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
        expect(result.output).toEqual(decision);
      }
    });

    it("handles markdown code block JSON from assistant", () => {
      const payload = { result: "completed", linesChanged: 42 };
      const stdout = [
        JSON.stringify({
          role: "assistant",
          content: "Here is the result:\n```json\n" + JSON.stringify(payload) + "\n```",
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
        JSON.stringify({ type: "start" }),
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

    it("fails closed when Codex stream emits no assistant event", () => {
      const stdout = [
        JSON.stringify({ type: "session.started" }),
        JSON.stringify({ type: "tool.called", tool: "bash" }),
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
        expect(result.message).toMatch(/did not emit a final assistant output event/);
      }
    });
  });

  describe("OpenCode JSON event adapter", () => {
    const openCodeProfile: HostAgentConfig = {
      ...baseProfile,
      runtimeKind: "opencode",
    };

    it("extracts assistant payload from OpenCode turn_complete event", () => {
      const payload = { status: "success", files: ["src/index.ts"] };
      const stdout = [
        JSON.stringify({ type: "step", step: 1 }),
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: JSON.stringify(payload),
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

    it("fails closed when OpenCode stream has no assistant output", () => {
      const stdout = JSON.stringify({ type: "step", step: 1 });
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
