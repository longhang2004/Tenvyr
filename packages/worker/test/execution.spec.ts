import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { AgentExecutionError, defineAgent } from "../src";
import { executeAgent } from "../src/execution/execute-run";
import { noOpLogger } from "../src/observability/safe-logger";

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "invocation-1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "echo",
  target: { agent: "echo-agent" },
  input: { message: "hello" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: { traceId: "trace-1", correlationId: "invocation-1" },
};

const execute = <TInput, TOutput>(
  agent: ReturnType<typeof defineAgent<TInput, TOutput>>,
  options: {
    timeoutMs?: number;
    clock?: () => number;
    shutdownSignal?: AbortSignal;
  } = {},
) =>
  executeAgent({
    agent,
    invocation,
    runId: "run-1",
    timeoutMs: options.timeoutMs ?? 1000,
    logger: noOpLogger,
    now: options.clock ?? (() => Date.parse("2026-07-26T00:00:01.000Z")),
    shutdownSignal: options.shutdownSignal,
  });

describe("agent execution", () => {
  it("maps a direct object containing output as raw output", async () => {
    const agent = defineAgent({
      name: "echo-agent",
      async execute() {
        return { output: "raw-value", extra: true };
      },
    });

    await expect(execute(agent)).resolves.toMatchObject({
      status: "succeeded",
      output: { output: "raw-value", extra: true },
    });
  });

  it("maps only context.success as structured success", async () => {
    const agent = defineAgent({
      name: "echo-agent",
      async execute(context) {
        return context.success({
          output: { echoed: true },
          usage: { totalTokens: 3 },
          artifacts: [{ id: "artifact-1", name: "result.json" }],
          metadata: { source: "test" },
        });
      },
    });

    await expect(execute(agent)).resolves.toMatchObject({
      status: "succeeded",
      output: { echoed: true },
      usage: { totalTokens: 3 },
      artifacts: [{ id: "artifact-1", name: "result.json" }],
      metadata: { source: "test" },
    });
  });

  it("preserves special JSON output keys without prototype mutation", async () => {
    const output = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"safe":true},"prototype":{"safe":true},"nested":{"__proto__":{"deep":true}}}',
    );
    const agent = defineAgent({
      name: "echo-agent",
      async execute() {
        return output;
      },
    });

    const result = await execute(agent);
    const normalized = result.output as Record<string, unknown>;

    expect(result.status).toBe("succeeded");
    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        normalized.nested as object,
        "__proto__",
      ),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(output);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("runs function input and object output parsers around the handler", async () => {
    const calls: string[] = [];
    const agent = defineAgent({
      name: "echo-agent",
      inputParser(value: unknown) {
        calls.push("input");
        return String((value as { message: string }).message);
      },
      outputParser: {
        parse(value: unknown) {
          calls.push("output");
          return String(value).toUpperCase();
        },
      },
      async execute(_context, input) {
        calls.push("execute");
        return input;
      },
    });

    const result = await execute(agent);

    expect(calls).toEqual(["input", "execute", "output"]);
    expect(result.output).toBe("HELLO");
  });

  it("does not invoke the handler when input parsing fails", async () => {
    const handler = jest.fn();
    const agent = defineAgent({
      name: "echo-agent",
      inputParser() {
        throw new Error("TOP_SECRET_INPUT");
      },
      execute: handler,
    });

    await expect(execute(agent)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "AGENT_INPUT_INVALID",
        retryable: false,
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps invalid or non-JSON output to AGENT_OUTPUT_INVALID", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const cases = [
      defineAgent({
        name: "echo-agent",
        outputParser() {
          throw new Error("TOP_SECRET_OUTPUT");
        },
        async execute() {
          return "value";
        },
      }),
      defineAgent({
        name: "echo-agent",
        async execute() {
          return circular;
        },
      }),
      defineAgent({
        name: "echo-agent",
        async execute() {
          return new Date();
        },
      }),
      defineAgent({
        name: "echo-agent",
        async execute() {
          return BigInt(1);
        },
      }),
    ];

    for (const agent of cases) {
      await expect(execute(agent as never)).resolves.toMatchObject({
        status: "failed",
        error: { code: "AGENT_OUTPUT_INVALID", retryable: false },
      });
    }
  });

  it("maps context.fail and direct AgentExecutionError to structured failures", async () => {
    const viaContext = defineAgent({
      name: "echo-agent",
      async execute(context) {
        context.fail({
          code: "REPOSITORY_UNAVAILABLE",
          message: "Repository could not be read",
          retryable: true,
          details: { host: "git.internal" },
        });
      },
    });
    const direct = defineAgent({
      name: "echo-agent",
      async execute() {
        throw new AgentExecutionError({
          code: "DIRECT_FAILURE",
          message: "Explicit direct failure",
          retryable: false,
        });
      },
    });

    await expect(execute(viaContext)).resolves.toMatchObject({
      status: "failed",
      error: { code: "REPOSITORY_UNAVAILABLE", retryable: true },
    });
    await expect(execute(direct)).resolves.toMatchObject({
      status: "failed",
      error: { code: "DIRECT_FAILURE", retryable: false },
    });
  });

  it("sanitizes unexpected errors and excludes stack/input/output from the result", async () => {
    const agent = defineAgent({
      name: "echo-agent",
      async execute() {
        throw new Error("TOP_SECRET_THROWN");
      },
    });

    const result = await execute(agent);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "AGENT_EXECUTION_FAILED",
        message: "Agent execution failed",
        retryable: false,
      },
    });
    expect(serialized).not.toContain("TOP_SECRET_THROWN");
    expect(serialized).not.toContain("stack");
  });

  it("aborts on timeout, emits one timed-out result, and ignores late resolution", async () => {
    let release!: () => void;
    const terminal = jest.fn();
    const agent = defineAgent({
      name: "echo-agent",
      async execute(context) {
        await new Promise<void>((resolve) => {
          release = resolve;
          context.signal.addEventListener("abort", terminal);
        });
        return "late-success";
      },
    });

    const resultPromise = execute(agent, { timeoutMs: 10 });
    await expect(resultPromise).resolves.toMatchObject({
      status: "timed_out",
      error: { code: "AGENT_EXECUTION_TIMEOUT", retryable: true },
    });
    expect(terminal).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(resultPromise).resolves.toMatchObject({ status: "timed_out" });
  });

  it("keeps timeout and shutdown classifications when abort-aware work rejects", async () => {
    const abortAwareAgent = defineAgent({
      name: "echo-agent",
      async execute(context) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        });
      },
    });

    await expect(
      execute(abortAwareAgent, { timeoutMs: 10 }),
    ).resolves.toMatchObject({
      status: "timed_out",
      error: { code: "AGENT_EXECUTION_TIMEOUT" },
    });

    const shutdown = new AbortController();
    const result = execute(abortAwareAgent, {
      timeoutMs: 1000,
      shutdownSignal: shutdown.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    shutdown.abort();
    await expect(result).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "WORKER_SHUTDOWN" },
    });
  });

  it("preserves IDs and emits valid timestamps without fabricating usage", async () => {
    const times = [
      Date.parse("2026-07-26T00:00:01.000Z"),
      Date.parse("2026-07-26T00:00:02.000Z"),
    ];
    const agent = defineAgent({ name: "echo-agent", async execute() {} });

    const result = await execute(agent, {
      clock: () => times.shift() as number,
    });

    expect(result).toMatchObject({
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      startedAt: "2026-07-26T00:00:01.000Z",
      completedAt: "2026-07-26T00:00:02.000Z",
    });
    expect(result).not.toHaveProperty("usage");
  });
});
