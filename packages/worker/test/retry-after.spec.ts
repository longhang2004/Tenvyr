import { readFileSync } from "fs";
import { resolve } from "path";
import { parseRetryAfterDeltaSeconds } from "../src/callback/retry-after";

type RetryAfterCase = {
  name: string;
  value: string | null;
  maximumSeconds: number;
  expected: { kind: "fallback" } | { kind: "header-delay"; seconds: number };
};

const cases = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../contracts/conformance/protocol/retry-after-cases.json",
    ),
    "utf8",
  ),
) as RetryAfterCase[];

describe("Retry-After delta-seconds", () => {
  it.each(cases)("handles $name without unbounded conversion", (testCase) => {
    const parsed = parseRetryAfterDeltaSeconds(
      testCase.value,
      testCase.maximumSeconds,
    );

    expect(parsed).toBe(
      testCase.expected.kind === "fallback"
        ? undefined
        : testCase.expected.seconds,
    );
  });
});
