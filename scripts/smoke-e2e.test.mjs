import assert from "node:assert/strict";
import test from "node:test";

import {
  SHOWCASE_PIPELINE,
  validateExecution,
  validatePipelineMetadata,
} from "./smoke-e2e.mjs";

const MOCK_PROVIDER_METADATA = {
  provider: "mock",
  model: "local-heuristic",
  fallbackUsed: true,
  usageSource: "estimated",
};

function execution(analyzeAttempt, providerMetadata = MOCK_PROVIDER_METADATA) {
  return {
    id: "execution-1",
    status: "COMPLETED",
    steps: [
      {
        stepId: "analyze-input",
        agent: "echo-analyzer",
        status: "COMPLETED",
        attempt: analyzeAttempt,
        maxAttempts: 2,
        output: {
          echo: "hello",
          _tenvyr: {
            runtime: "python",
            language: "python",
            transport: "http",
          },
        },
      },
      {
        stepId: "quality-gate",
        agent: "code-reviewer",
        status: "COMPLETED",
        attempt: 1,
        output: providerMetadata
          ? { _tenvyr: { metadata: providerMetadata } }
          : {},
      },
    ],
  };
}

test("accepts success and retry-once execution evidence", () => {
  assert.equal(validateExecution(execution(1), 1).analyze.attempt, 1);
  assert.equal(validateExecution(execution(2), 2).analyze.attempt, 2);
  const missingLanguage = execution(1);
  delete missingLanguage.steps[0].output._tenvyr.language;
  assert.throws(
    () => validateExecution(missingLanguage, 1),
    /Python language metadata missing/,
  );
});

test("declares every showcase runtime and transport hop", () => {
  assert.deepEqual(validatePipelineMetadata(), {
    analyze: {
      runtime: "python",
      language: "python",
      transport: "http",
    },
    quality: {
      runtime: "typescript",
      language: "typescript",
      transport: "kafka",
      runnerRuntime: "java",
    },
  });
  assert.throws(
    () =>
      validatePipelineMetadata({
        ...SHOWCASE_PIPELINE,
        steps: SHOWCASE_PIPELINE.steps.map((step) =>
          step.id === "quality-gate"
            ? { ...step, metadata: { ...step.metadata, runnerRuntime: "" } }
            : step,
        ),
      }),
    /TypeScript Kafka agent and Java runner hops/,
  );
});

test("requires provider metadata at its persisted output shape", () => {
  assert.equal(
    validateExecution(execution(1), 1).provider.model,
    "local-heuristic",
  );
  assert.throws(
    () => validateExecution(execution(1, null), 1),
    /provider metadata is missing/,
  );
});

test("requires direct default mock evidence", () => {
  assert.throws(
    () =>
      validateExecution(
        execution(1, { ...MOCK_PROVIDER_METADATA, fallbackUsed: false }),
        1,
      ),
    /provider=mock and fallbackUsed=true/,
  );
  assert.throws(
    () =>
      validateExecution(
        execution(1, { ...MOCK_PROVIDER_METADATA, provider: "openai" }),
        1,
      ),
    /provider=mock and fallbackUsed=true/,
  );
});
