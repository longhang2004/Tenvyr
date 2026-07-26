import {
  AgentExecutionError,
  createAgentWeaveWorker,
  defineAgent,
  type AgentDefinition,
  type AgentExecutionContext,
  type AgentExecutionSuccess,
  type AgentFailureOptions,
  type AgentWeaveWorker,
  type AgentWeaveWorkerConfig,
  type WorkerAddress,
  type WorkerLifecycleState,
  type WorkerLogger,
} from "../src";

describe("public API", () => {
  it("exports only the intended runtime values", () => {
    expect(Object.keys(require("../src")).sort()).toEqual([
      "AgentExecutionError",
      "createAgentWeaveWorker",
      "defineAgent",
    ]);
  });

  it("loads the compiled package through its manifest entry point", () => {
    const compiledPackage = require("..");

    expect(Object.keys(compiledPackage).sort()).toEqual([
      "AgentExecutionError",
      "createAgentWeaveWorker",
      "defineAgent",
    ]);
    expect(compiledPackage.createAgentWeaveWorker).toBeInstanceOf(Function);
  });

  it("preserves generic input and output inference with function and Zod-like parsers", async () => {
    const functionAgent = defineAgent({
      name: "function-parser",
      inputParser: (value: unknown) => ({ value: String(value) }),
      outputParser: (value: unknown) => ({ length: Number(value) }),
      async execute(_context, input) {
        const typed: string = input.value;
        return { length: typed.length };
      },
    });
    const objectAgent = defineAgent({
      name: "object-parser",
      inputParser: {
        parse(value: unknown) {
          return { count: Number(value) };
        },
      },
      async execute(_context, input) {
        const typed: number = input.count;
        return { doubled: typed * 2 };
      },
    });

    expect(functionAgent.name).toBe("function-parser");
    expect(objectAgent.name).toBe("object-parser");
  });

  it("keeps all documented types consumable without extra root exports", () => {
    const typesCompile: [
      AgentDefinition<unknown, unknown>?,
      AgentExecutionContext?,
      AgentExecutionSuccess<unknown>?,
      AgentFailureOptions?,
      AgentWeaveWorker?,
      AgentWeaveWorkerConfig<unknown, unknown>?,
      WorkerAddress?,
      WorkerLifecycleState?,
      WorkerLogger?,
    ] = [];

    expect(typesCompile).toEqual([]);
    expect(AgentExecutionError).toBeInstanceOf(Function);
    expect(createAgentWeaveWorker).toBeInstanceOf(Function);
  });
});
