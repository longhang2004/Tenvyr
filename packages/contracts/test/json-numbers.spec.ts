import { readFileSync } from "fs";
import { resolve } from "path";
import {
  ContractValidationError,
  parseAgentEvent,
  parseAgentInvocation,
  parseAgentResult,
  parseHttpAgentRunRequest,
} from "../src";

const fixtureRoot = resolve(
  __dirname,
  "../../../contracts/conformance/json-numbers",
);

function rawFixture(kind: "valid" | "invalid", name: string): string {
  return readFileSync(resolve(fixtureRoot, kind, name), "utf8");
}

describe("protocol JSON number interoperability", () => {
  it.each([
    "safe-integer-boundaries.json",
    "finite-floats.json",
    "booleans.json",
  ])("accepts the complete valid request fixture %s", (name) => {
    const raw = rawFixture("valid", name);

    expect(parseHttpAgentRunRequest(JSON.parse(raw))).toBeDefined();
  });

  it("preserves both safe integer boundaries exactly", () => {
    const raw = rawFixture("valid", "safe-integer-boundaries.json");
    const parsed = parseHttpAgentRunRequest(JSON.parse(raw));

    expect(raw).toContain("9007199254740991");
    expect(raw).toContain("-9007199254740991");
    expect(parsed.invocation.input).toEqual({
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: Number.MIN_SAFE_INTEGER,
    });
  });

  it.each([
    ["integer-above-safe-max.json", "9007199254740993"],
    ["integer-below-safe-min.json", "-9007199254740993"],
    ["nested-unsafe-integer.json", "9007199254740993"],
  ])(
    "rejects exact literal bytes in the complete request fixture %s",
    (name, unsafeLiteral) => {
      const raw = rawFixture("invalid", name);

      expect(raw).toContain(unsafeLiteral);
      expect(() => parseHttpAgentRunRequest(JSON.parse(raw))).toThrow(
        ContractValidationError,
      );
    },
  );

  it.each([
    ["unsafe-integer-in-output.json", "9007199254740993"],
    ["unsafe-integer-in-metadata.json", "-9007199254740993"],
  ])(
    "rejects exact literal bytes in the complete result fixture %s",
    (name, unsafeLiteral) => {
      const raw = rawFixture("invalid", name);

      expect(raw).toContain(unsafeLiteral);
      expect(() => parseAgentResult(JSON.parse(raw))).toThrow(
        ContractValidationError,
      );
    },
  );

  it("enforces the numeric policy recursively at every contract boundary", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const invocation = {
      schemaVersion: "1",
      invocationId: "invocation-1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      stepId: "echo",
      target: { agent: "echo-agent" },
      input: { nested: [unsafe] },
      attempt: 1,
      createdAt: "2026-07-26T00:00:00.000Z",
      trace: { traceId: "trace-1", correlationId: "invocation-1" },
    };
    const result = {
      schemaVersion: "1",
      invocationId: "invocation-1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      status: "succeeded",
      output: null,
      completedAt: "2026-07-26T00:00:01.000Z",
      metadata: { nested: [unsafe] },
    };
    const event = {
      schemaVersion: "1",
      eventId: "event-1",
      invocationId: "invocation-1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      sequence: 0,
      type: "progress",
      occurredAt: "2026-07-26T00:00:00.500Z",
      payload: { nested: [unsafe] },
      trace: { traceId: "trace-1", correlationId: "invocation-1" },
    };

    expect(() => parseAgentInvocation(invocation)).toThrow(
      ContractValidationError,
    );
    expect(() => parseAgentResult(result)).toThrow(ContractValidationError);
    expect(() => parseAgentEvent(event)).toThrow(ContractValidationError);
    expect(() =>
      parseAgentInvocation({ ...invocation, input: { value: Infinity } }),
    ).toThrow(ContractValidationError);
  });
});
