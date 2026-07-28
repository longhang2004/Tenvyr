import {
  AgentExecutionError,
  createTenvyrWorker,
  defineAgent,
  type AgentDefinition,
  type AgentExecutionContext,
  type AgentExecutionSuccess,
  type AgentFailureOptions,
  type TenvyrWorker,
  type TenvyrWorkerConfig,
  type WorkerAddress,
  type WorkerLifecycleState,
  type WorkerLogger,
} from "../src";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("public API", () => {
  it("exports only the intended runtime values", () => {
    expect(Object.keys(require("../src")).sort()).toEqual([
      "AgentExecutionError",
      "createTenvyrWorker",
      "defineAgent",
    ]);
  });

  it("loads the compiled package through its manifest entry point", () => {
    const compiledPackage = require("..");

    expect(Object.keys(compiledPackage).sort()).toEqual([
      "AgentExecutionError",
      "createTenvyrWorker",
      "defineAgent",
    ]);
    expect(compiledPackage.createTenvyrWorker).toBeInstanceOf(Function);
    expect(compiledPackage.createAgentWeaveWorker).toBeUndefined();
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
      TenvyrWorker?,
      TenvyrWorkerConfig<unknown, unknown>?,
      WorkerAddress?,
      WorkerLifecycleState?,
      WorkerLogger?,
    ] = [];

    expect(typesCompile).toEqual([]);
    expect(AgentExecutionError).toBeInstanceOf(Function);
    expect(createTenvyrWorker).toBeInstanceOf(Function);
  });

  it("keeps the compiled declaration surface limited to approved root exports", () => {
    const declaration = readFileSync(
      resolve(__dirname, "../dist/index.d.ts"),
      "utf8",
    );

    expect(declaration).toContain(
      'export { AgentExecutionError } from "./public/errors";',
    );
    expect(declaration).toContain(
      'export { createTenvyrWorker } from "./public/create-worker";',
    );
    expect(declaration).toContain(
      'export { defineAgent } from "./public/define-agent";',
    );
    for (const name of [
      "createAgentWeaveWorker",
      "AgentWeaveWorker",
      "AgentWeaveWorkerConfig",
      "AgentWeaveWorkerRuntime",
      "TenvyrWorkerRuntime",
      "InMemoryIdempotencyStore",
      "RunScheduler",
      "RunRecord",
      "deliverCallback",
      "test clock",
      "callback secret",
    ]) {
      expect(declaration).not.toContain(name);
    }
  });
});
