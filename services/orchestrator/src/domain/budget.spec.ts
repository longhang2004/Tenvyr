import {
  BUDGET_AMOUNT_MAX,
  BudgetError,
  projectAll,
  projectAvailable,
  validateAmount,
  validateCeilings,
  validateDelta,
  validateDimension,
  validateEvidence,
  validateSource,
  parseStepBudget,
  reservationKeyForAttempt,
  usageFromResult,
  type BudgetEntryFact,
} from "./budget";

const expectCode = (fail: () => unknown, code: string): void => {
  try {
    fail();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

describe("budget dimension and amount validation", () => {
  it("accepts canonical positive integer amounts per dimension", () => {
    expect(validateAmount("tokens", 10_000)).toBe(10_000);
    expect(validateAmount("currency_micros", 1)).toBe(1);
    expect(validateAmount("wall_time_ms", 5_000)).toBe(5_000);
  });

  it("rejects unknown dimensions and cross-unit confusion", () => {
    expect(() => validateDimension("dollars")).toThrow(BudgetError);
    expectCode(() => validateAmount("tokens", "10000"), "AMOUNT_INVALID");
  });

  it("rejects floats, zero, negatives, and overflow", () => {
    expectCode(() => validateAmount("tokens", 1.5), "AMOUNT_INVALID");
    expectCode(() => validateAmount("tokens", 0), "AMOUNT_INVALID");
    expectCode(() => validateAmount("tokens", -5), "AMOUNT_INVALID");
    expectCode(
      () => validateAmount("tokens", BUDGET_AMOUNT_MAX + 1),
      "AMOUNT_OVERFLOW",
    );
    // No binary floating-point money anywhere.
    expectCode(() => validateAmount("currency_micros", 0.1), "AMOUNT_INVALID");
  });

  it("validates signed adjust deltas and ceilings", () => {
    expect(validateDelta("tokens", -100)).toBe(-100);
    expectCode(() => validateDelta("tokens", 0), "DELTA_INVALID");
    expectCode(() => validateDelta("tokens", 1.5), "DELTA_INVALID");
    expect(validateCeilings({ tokens: 100, wall_time_ms: 5_000 })).toEqual({
      tokens: 100,
      wall_time_ms: 5_000,
    });
    expectCode(() => validateCeilings({}), "DIMENSION_MISSING");
    expectCode(() => validateCeilings({ tokens: -1 }), "AMOUNT_INVALID");
  });

  it("validates usage source and evidence bounds", () => {
    expect(validateSource("actual")).toBe("actual");
    expect(validateSource("unknown")).toBe("unknown");
    expectCode(() => validateSource("guessed"), "CONFIDENCE_INVALID");
    expect(validateEvidence({ attemptId: "a" })).toEqual({ attemptId: "a" });
    expectCode(() => validateEvidence("secret"), "EVIDENCE_TOO_LARGE");
    expectCode(
      () => validateEvidence({ blob: "x".repeat(5000) }),
      "EVIDENCE_TOO_LARGE",
    );
  });
});

describe("availability projection", () => {
  const ceilings = { currency_micros: 1_000_000, tokens: 10_000 };

  it("starts at the grant ceiling", () => {
    expect(projectAvailable(ceilings, [], "tokens")).toBe(10_000);
  });

  it("reserve debits, release credits, commit is evidence only, adjust moves the ceiling", () => {
    const facts: BudgetEntryFact[] = [
      { operation: "reserve", dimension: "tokens", amount: 6_000, source: "unknown" },
      { operation: "commit", dimension: "tokens", amount: 4_200, source: "actual" },
      { operation: "release", dimension: "tokens", amount: 1_800, source: "unknown" },
    ];
    // reserve 6000 − release 1800 = net debit 4200; the commit does not move
    // availability.
    expect(projectAvailable(ceilings, facts, "tokens")).toBe(10_000 - 4_200);

    const adjusted: BudgetEntryFact[] = [
      ...facts,
      { operation: "adjust", dimension: "tokens", amount: 500, delta: 500, source: "actual" },
    ];
    expect(projectAvailable(ceilings, adjusted, "tokens")).toBe(10_000 - 4_200 + 500);
  });

  it("dimensions never convert and missing ceilings project to zero", () => {
    const facts: BudgetEntryFact[] = [
      { operation: "reserve", dimension: "currency_micros", amount: 100, source: "unknown" },
    ];
    expect(projectAvailable(ceilings, facts, "currency_micros")).toBe(999_900);
    expect(projectAll(ceilings, facts)).toEqual({
      currency_micros: 999_900,
      tokens: 10_000,
    });
  });

  it("rejects a negative projection (corrupt ledger)", () => {
    const facts: BudgetEntryFact[] = [
      { operation: "reserve", dimension: "tokens", amount: 20_000, source: "unknown" },
    ];
    expectCode(
      () => projectAvailable(ceilings, facts, "tokens"),
      "AVAILABILITY_NEGATIVE",
    );
  });
});

describe("M4-S2 usage mapping and reservation keys", () => {
  it("maps totalTokens to actual tokens and costUsd to estimated micros", () => {
    expect(usageFromResult({ totalTokens: 1234, costUsd: 0.42 })).toEqual([
      { dimension: "tokens", amount: 1234, source: "actual" },
      { dimension: "currency_micros", amount: 420_000, source: "estimated" },
    ]);
    // Rounding is deterministic (half away from zero via Math.round).
    expect(usageFromResult({ costUsd: 0.000001 })).toEqual([
      { dimension: "currency_micros", amount: 1, source: "estimated" },
    ]);
  });

  it("returns no observations when usage is absent", () => {
    expect(usageFromResult(undefined)).toEqual([]);
    expect(usageFromResult({})).toEqual([]);
  });

  it("rejects malformed usage instead of minting or erasing money", () => {
    expectCode(() => usageFromResult({ totalTokens: -1 }), "AMOUNT_INVALID");
    expectCode(() => usageFromResult({ totalTokens: 1.5 }), "AMOUNT_INVALID");
    expectCode(() => usageFromResult({ costUsd: -0.01 }), "AMOUNT_INVALID");
    expectCode(() => usageFromResult({ costUsd: NaN }), "AMOUNT_INVALID");
    expectCode(
      () => usageFromResult({ costUsd: 0.0000001 }),
      "AMOUNT_INVALID",
    );
    expectCode(() => usageFromResult("usage"), "AMOUNT_INVALID");
  });

  it("derives per-attempt reservation keys including the dimension", () => {
    const key = reservationKeyForAttempt("e1", "s1", 2, "tokens");
    expect(key).toBe("e1:s1:2:tokens");
    expect(key).not.toBe(reservationKeyForAttempt("e1", "s1", 3, "tokens"));
    expect(key).not.toBe(reservationKeyForAttempt("e1", "s1", 2, "wall_time_ms"));
  });

  it("parses optional step budgets with bounds", () => {
    expect(parseStepBudget(undefined)).toBeUndefined();
    expect(parseStepBudget({ tokens: 100 })).toEqual({ tokens: 100 });
    expectCode(() => parseStepBudget({ tokens: -1 }), "AMOUNT_INVALID");
    expectCode(() => parseStepBudget({ dollars: 1 }), "DIMENSION_UNKNOWN");
  });
});
