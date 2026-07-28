import * as fc from "fast-check";
import { parseAgentResult } from "@tenvyr/contracts";
import { KafkaService } from "./kafka.service";

// Test seam for the private, pure `parseDurationMs` helper.
//
// Constructing `KafkaService` only instantiates kafkajs client objects in the
// constructor (new Kafka(...), .producer(), .consumer()); no network connection
// is opened until `onModuleInit`, which these tests never call. We therefore
// build a single instance and reach the private method via an `any` cast.
const service = new KafkaService();
const parseDurationMs = (
  duration: string | number | undefined,
): number | null => (service as any).parseDurationMs(duration);

// Recognized unit suffixes and their millisecond factors (an omitted unit
// defaults to milliseconds).
const UNIT_FACTORS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

// Feature: tenvyr-verification-hardening, Property 1: Duration strings convert to the correct millisecond magnitude
describe("parseDurationMs - Property 1: Duration strings convert to the correct millisecond magnitude", () => {
  // Integer magnitudes keep the expected product (n * factor) exact and avoid
  // floating-point rounding ambiguity. Max product is 1_000_000 * 3_600_000
  // (= 3.6e12), well within Number.MAX_SAFE_INTEGER.
  it('converts "<n><unit>" to n * factor for every recognized unit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom("ms", "s", "m", "h"),
        (n, unit) => {
          expect(parseDurationMs(`${n}${unit}`)).toBe(n * UNIT_FACTORS[unit]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("treats an omitted unit as milliseconds (factor 1)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
        expect(parseDurationMs(`${n}`)).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it("returns the number unchanged for any positive numeric input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          fc
            .double({ noNaN: true, noDefaultInfinity: true })
            .filter((n) => n > 0),
        ),
        (n) => {
          expect(parseDurationMs(n)).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Mirrors the grammar `parseDurationMs` accepts: a number with an optional
// `ms|s|m|h` suffix, matched case-insensitively against the trimmed string.
// Used only to FILTER generated "garbage" so the generator never emits an
// accidentally-valid duration (which would be a false counterexample).
const GRAMMAR = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i;
const matchesGrammar = (value: string): boolean => GRAMMAR.test(value.trim());

// Feature: tenvyr-verification-hardening, Property 2: Malformed or non-positive durations are rejected
describe("parseDurationMs - Property 2: Malformed or non-positive durations are rejected", () => {
  it("returns null for any string outside the <number><optional ms|s|m|h> grammar", () => {
    fc.assert(
      fc.property(
        fc
          .oneof(
            // Empty / whitespace-only inputs.
            fc.constantFrom("", " ", "   ", "\t", "\n"),
            // Hand-picked alphabetic, symbolic, and near-miss garbage that the
            // grammar must reject (verified to never match GRAMMAR).
            fc.constantFrom(
              "abc",
              "ms",
              "s",
              "h",
              "minutes",
              "5min",
              "5 s",
              "1.2.3",
              "ten",
              "NaN",
              "Infinity",
              "0x10",
              "1e3",
              "$$$",
              "-",
              "+",
              ".",
              "..",
            ),
            // Arbitrary fuzzed strings.
            fc.string(),
          )
          // Drop anything that, after trimming, is actually a valid duration so
          // there are no false counterexamples (e.g. ' 5s ' or a random '42').
          .filter((s) => !matchesGrammar(s)),
        (input) => {
          expect(parseDurationMs(input)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null for any non-positive number (zero and negatives)", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: 0 }),
          fc
            .double({ noNaN: true, noDefaultInfinity: true })
            .filter((n) => n <= 0),
        ),
        (n) => {
          expect(parseDurationMs(n)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null for the literal values undefined and null", () => {
    fc.assert(
      fc.property(fc.constantFrom(undefined, null), (value) => {
        expect((service as any).parseDurationMs(value)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

describe("KafkaService contract boundary", () => {
  let boundaryService: KafkaService;
  let send: jest.Mock;

  beforeEach(() => {
    boundaryService = new KafkaService();
    send = jest.fn().mockResolvedValue(undefined);
    (boundaryService as any).producer = { send };
    (boundaryService as any).callRunner = jest.fn().mockResolvedValue({
      data: {
        output: '{"score":100,"findings":[]}',
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
        metadata: {
          provider: "mock",
          model: "local-heuristic",
          fallbackUsed: true,
          usageSource: "estimated",
        },
      },
    });
  });

  const messagePayload = (value: unknown) =>
    ({
      message: {
        key: Buffer.from("execution-1"),
        value: Buffer.from(JSON.stringify(value)),
        timestamp: "1785024000000",
      },
    }) as any;

  it("consumes a v1 invocation and publishes a correlated v1 result", async () => {
    await (boundaryService as any).processTask(
      messagePayload({
        schemaVersion: "1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        stepId: "review",
        target: { agent: "code-reviewer" },
        input: { code: "const safe = true;", language: "typescript" },
        attempt: 1,
        createdAt: "2026-07-26T00:00:00.000Z",
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      }),
    );

    const result = parseAgentResult(
      JSON.parse(send.mock.calls[0][0].messages[0].value),
    );
    expect(result).toMatchObject({
      schemaVersion: "1",
      invocationId: "step-execution-1:1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      status: "succeeded",
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      metadata: {
        provider: "mock",
        model: "local-heuristic",
        fallbackUsed: true,
        usageSource: "estimated",
      },
      output: {
        score: 100,
        findings: [],
        _tenvyr: {
          metadata: {
            provider: "mock",
            model: "local-heuristic",
            fallbackUsed: true,
            usageSource: "estimated",
          },
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        },
      },
    });
  });

  it("still consumes a legacy invocation and publishes a v1 result", async () => {
    await (boundaryService as any).processTask(
      messagePayload({
        executionId: "execution-1",
        stepId: "review",
        agent: "code-reviewer",
        input: { code: "const safe = true;", language: "typescript" },
        attempt: 1,
        timestamp: "2026-07-26T00:00:00.000Z",
      }),
    );

    const result = parseAgentResult(
      JSON.parse(send.mock.calls[0][0].messages[0].value),
    );
    expect(result).toMatchObject({
      schemaVersion: "1",
      invocationId: "legacy:execution-1:review:1",
      executionId: "execution-1",
      stepExecutionId: "legacy:execution-1:review",
      status: "succeeded",
    });
  });

  it("does not crash, call the runner, or publish success for an invalid task", async () => {
    await expect(
      (boundaryService as any).processTask(
        messagePayload({ executionId: "execution-1" }),
      ),
    ).resolves.toBeUndefined();
    expect((boundaryService as any).callRunner).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not log malformed invocation contents", async () => {
    const error = jest.spyOn(console, "error").mockImplementation();
    const payload = messagePayload({});
    payload.message.value = Buffer.from("{TOP_SECRET:not-json");

    await (boundaryService as any).processTask(payload);

    expect(JSON.stringify(error.mock.calls)).not.toContain("TOP_SECRET");
    expect((boundaryService as any).callRunner).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
