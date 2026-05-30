import * as fc from 'fast-check';
import { EngineService } from './engine.service';
import { StepExecutionEntity, StepStatus } from '../entities/step-execution.entity';

// Test seam for the private, pure helpers on EngineService.
//
// The constructor only stores its three collaborators (PipelineService,
// ExecutionService, KafkaService) as instance fields; none of the pure helpers
// exercised below touch them, and no DB/Kafka connection is opened. We build a
// single instance with trivial mock collaborators and reach the private methods
// via an `any` cast.
const service = new EngineService({} as any, {} as any, {} as any);

const parseDurationMs = (duration: string | number | undefined): number | null =>
  (service as any).parseDurationMs(duration);
const getMaxAttempts = (retries?: unknown): number =>
  (service as any).getMaxAttempts({ retries });
const getValueFromPath = (obj: unknown, pathParts: string[]): unknown =>
  (service as any).getValueFromPath(obj, pathParts);
const isDependencyResolved = (
  dependencyExecution: Partial<StepExecutionEntity> | undefined,
  steps: unknown[],
): boolean => (service as any).isDependencyResolved(dependencyExecution, steps);
const resolveInputTemplates = (
  inputConfig: unknown,
  pipelineInput: unknown,
  stepExecutions: Array<Partial<StepExecutionEntity>>,
): unknown => (service as any).resolveInputTemplates(inputConfig, pipelineInput, stepExecutions);
const buildTemplateContext = (
  pipelineInput: unknown,
  stepExecutions: Array<Partial<StepExecutionEntity>>,
): unknown => (service as any).buildTemplateContext(pipelineInput, stepExecutions);

// Helper to fabricate a step-execution row with sensible defaults.
const stepExec = (
  overrides: Partial<StepExecutionEntity> & { stepId: string },
): Partial<StepExecutionEntity> => ({
  status: 'COMPLETED' as StepStatus,
  output: null,
  attempt: 1,
  ...overrides,
});

// Recognized unit suffixes and their millisecond factors (an omitted unit
// defaults to milliseconds). Mirrors the multiplier table in parseDurationMs.
const UNIT_FACTORS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

describe('EngineService pure helpers', () => {
  describe('getMaxAttempts', () => {
    it('returns 1 when retries is 0', () => {
      expect(getMaxAttempts(0)).toBe(1);
    });

    it('returns 1 when retries is undefined', () => {
      expect((service as any).getMaxAttempts({})).toBe(1);
    });

    it('returns retries + 1 for a positive integer (3 -> 4)', () => {
      expect(getMaxAttempts(3)).toBe(4);
    });

    it('returns 1 for negative retries', () => {
      expect(getMaxAttempts(-5)).toBe(1);
    });

    it('returns 1 for NaN retries', () => {
      expect(getMaxAttempts(NaN)).toBe(1);
    });

    it('floors fractional retries (2.7 -> 3)', () => {
      expect(getMaxAttempts(2.7)).toBe(3);
    });
  });

  describe('getValueFromPath', () => {
    const obj = { a: { b: { c: 42 } }, nil: null };

    it('returns the nested value on a hit', () => {
      expect(getValueFromPath(obj, ['a', 'b', 'c'])).toBe(42);
    });

    it('returns undefined when a segment is missing (miss)', () => {
      expect(getValueFromPath(obj, ['a', 'x', 'c'])).toBeUndefined();
    });

    it('returns undefined when a mid-path segment is null', () => {
      expect(getValueFromPath(obj, ['nil', 'whatever'])).toBeUndefined();
    });

    it('returns the object itself for an empty path', () => {
      expect(getValueFromPath(obj, [])).toBe(obj);
    });
  });

  describe('isDependencyResolved', () => {
    const steps = [
      { id: 'continueStep', agent: 'a', onFailure: 'continue' },
      { id: 'stopStep', agent: 'a', onFailure: 'stop' },
      { id: 'defaultStep', agent: 'a' },
    ];

    it('returns false when the dependency execution is undefined', () => {
      expect(isDependencyResolved(undefined, steps)).toBe(false);
    });

    it('returns true for a COMPLETED dependency', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'continueStep', status: 'COMPLETED' }), steps)).toBe(true);
    });

    it('returns true for a SKIPPED dependency', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'continueStep', status: 'SKIPPED' }), steps)).toBe(true);
    });

    it('returns false for a still-RUNNING dependency', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'continueStep', status: 'RUNNING' }), steps)).toBe(false);
    });

    it('returns false for a PENDING dependency', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'continueStep', status: 'PENDING' }), steps)).toBe(false);
    });

    it('returns true for a FAILED dependency whose step has onFailure: continue', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'continueStep', status: 'FAILED' }), steps)).toBe(true);
    });

    it('returns false for a FAILED dependency whose step has onFailure: stop', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'stopStep', status: 'FAILED' }), steps)).toBe(false);
    });

    it('returns false for a FAILED dependency with no onFailure policy (defaults to stop)', () => {
      expect(isDependencyResolved(stepExec({ stepId: 'defaultStep', status: 'FAILED' }), steps)).toBe(false);
    });
  });

  describe('buildTemplateContext', () => {
    it('shapes pipeline input and per-step result/output/status/error/attempt', () => {
      const stepExecutions = [
        stepExec({ stepId: 'review', status: 'COMPLETED', output: { score: 9 }, error: undefined, attempt: 2 }),
      ];

      const context = buildTemplateContext({ repo: 'demo' }, stepExecutions) as any;

      expect(context.pipeline.input).toEqual({ repo: 'demo' });
      expect(context.steps.review).toEqual({
        result: { score: 9 },
        output: { score: 9 },
        status: 'COMPLETED',
        error: undefined,
        attempt: 2,
      });
    });
  });

  describe('resolveInputTemplates', () => {
    const stepExecutions = [
      stepExec({ stepId: 'a', status: 'COMPLETED', output: { foo: 'bar' }, attempt: 1 }),
      stepExec({ stepId: 'num', status: 'COMPLETED', output: 42, attempt: 1 }),
      stepExec({ stepId: 'str', status: 'COMPLETED', output: 'hello', attempt: 1 }),
    ];

    it('passes a resolved object through unchanged for an exact-match template', () => {
      const result = resolveInputTemplates({ payload: '{{ steps.a.result }}' }, {}, stepExecutions);
      expect(result).toEqual({ payload: { foo: 'bar' } });
    });

    it('interpolates stringified values inline', () => {
      const result = resolveInputTemplates(
        { msg: 'count={{ steps.num.result }} name={{ steps.str.result }}' },
        {},
        stepExecutions,
      );
      expect(result).toEqual({ msg: 'count=42 name=hello' });
    });

    it('JSON-stringifies objects when interpolated inline', () => {
      const result = resolveInputTemplates({ msg: 'data={{ steps.a.result }}' }, {}, stepExecutions);
      expect(result).toEqual({ msg: 'data={"foo":"bar"}' });
    });

    it('substitutes an empty string for a missing path used inline', () => {
      const result = resolveInputTemplates({ msg: 'x={{ steps.missing.result }}' }, {}, stepExecutions);
      expect(result).toEqual({ msg: 'x=' });
    });

    it('returns null for a missing path used as an exact-match template', () => {
      const result = resolveInputTemplates({ payload: '{{ steps.missing.result }}' }, {}, stepExecutions);
      expect(result).toEqual({ payload: null });
    });

    it('passes non-string values through untouched', () => {
      const input = { n: 7, flag: true, nothing: null };
      expect(resolveInputTemplates(input, {}, stepExecutions)).toEqual(input);
    });

    it('recurses through nested objects and arrays', () => {
      const result = resolveInputTemplates(
        {
          outer: { inner: '{{ steps.str.result }}' },
          list: ['{{ steps.num.result }}', 'static', '{{ steps.a.result }}'],
        },
        {},
        stepExecutions,
      );
      expect(result).toEqual({
        outer: { inner: 'hello' },
        list: [42, 'static', { foo: 'bar' }],
      });
    });

    it('resolves pipeline input via the exact-match template', () => {
      const result = resolveInputTemplates({ in: '{{ pipeline.input }}' }, { mode: 'fast' }, stepExecutions);
      expect(result).toEqual({ in: { mode: 'fast' } });
    });
  });

  // Feature: ci-and-coverage, Property 1: parseDurationMs converts "<n><unit>" to n * factor (omitted unit = ms), and passes positive numbers through unchanged
  describe('parseDurationMs - Property 1: duration strings convert to the correct millisecond magnitude', () => {
    // Integer magnitudes keep the product (n * factor) exact and dodge
    // floating-point rounding ambiguity. Max product 1_000_000 * 3_600_000
    // (= 3.6e12) is well within Number.MAX_SAFE_INTEGER.
    it('converts "<n><unit>" to n * factor for every recognized unit', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.constantFrom('ms', 's', 'm', 'h'),
          (n, unit) => {
            expect(parseDurationMs(`${n}${unit}`)).toBe(n * UNIT_FACTORS[unit]);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('treats an omitted unit as milliseconds (factor 1)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
          expect(parseDurationMs(`${n}`)).toBe(n);
        }),
        { numRuns: 100 },
      );
    });

    it('returns any positive number unchanged', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => n > 0),
          ),
          (n) => {
            expect(parseDurationMs(n)).toBe(n);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: ci-and-coverage, Property 2: getMaxAttempts always returns an integer >= 1 for any retries input, and equals retries + 1 for integer retries >= 1
  describe('getMaxAttempts - Property 2: result is always an integer >= 1', () => {
    it('returns an integer >= 1 for ANY retries value (negative, NaN, fractional, infinite, huge, undefined)', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer(),
            fc.double(), // includes NaN and +/-Infinity by default
            fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, undefined, null),
          ),
          (retries) => {
            const result = getMaxAttempts(retries);
            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('equals retries + 1 for any integer retries >= 1', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 1_000_000 }), (retries) => {
          expect(getMaxAttempts(retries)).toBe(retries + 1);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: ci-and-coverage, Property 3: parseDurationMs rejects malformed strings and non-positive numbers
  describe('parseDurationMs - Property 3: malformed or non-positive durations are rejected', () => {
    // Mirrors the grammar parseDurationMs accepts so generated garbage that is
    // accidentally a valid duration is filtered out (avoiding false counterexamples).
    const GRAMMAR = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i;
    const matchesGrammar = (value: string): boolean => GRAMMAR.test(value.trim());

    it('returns null for any string outside the <number><optional ms|s|m|h> grammar', () => {
      fc.assert(
        fc.property(
          fc
            .oneof(
              fc.constantFrom('', ' ', '   ', '\t', '\n'),
              fc.constantFrom('abc', 'ms', 's', 'h', '5 s', '1.2.3', 'ten', 'NaN', 'Infinity', '0x10', '1e3', '$$$'),
              fc.string(),
            )
            .filter((s) => !matchesGrammar(s)),
          (input) => {
            expect(parseDurationMs(input)).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns null for any non-positive number (zero and negatives)', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer({ max: 0 }),
            fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => n <= 0),
          ),
          (n) => {
            expect(parseDurationMs(n)).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
