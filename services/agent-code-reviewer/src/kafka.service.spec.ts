import * as fc from 'fast-check';
import { KafkaService } from './kafka.service';

// Test seam for the private, pure `parseDurationMs` helper.
//
// Constructing `KafkaService` only instantiates kafkajs client objects in the
// constructor (new Kafka(...), .producer(), .consumer()); no network connection
// is opened until `onModuleInit`, which these tests never call. We therefore
// build a single instance and reach the private method via an `any` cast.
const service = new KafkaService();
const parseDurationMs = (duration: string | number | undefined): number | null =>
  (service as any).parseDurationMs(duration);

// Recognized unit suffixes and their millisecond factors (an omitted unit
// defaults to milliseconds).
const UNIT_FACTORS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

// Feature: agentweave-verification-hardening, Property 1: Duration strings convert to the correct millisecond magnitude
describe('parseDurationMs - Property 1: Duration strings convert to the correct millisecond magnitude', () => {
  // Integer magnitudes keep the expected product (n * factor) exact and avoid
  // floating-point rounding ambiguity. Max product is 1_000_000 * 3_600_000
  // (= 3.6e12), well within Number.MAX_SAFE_INTEGER.
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

  it('returns the number unchanged for any positive numeric input', () => {
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

// Mirrors the grammar `parseDurationMs` accepts: a number with an optional
// `ms|s|m|h` suffix, matched case-insensitively against the trimmed string.
// Used only to FILTER generated "garbage" so the generator never emits an
// accidentally-valid duration (which would be a false counterexample).
const GRAMMAR = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i;
const matchesGrammar = (value: string): boolean => GRAMMAR.test(value.trim());

// Feature: agentweave-verification-hardening, Property 2: Malformed or non-positive durations are rejected
describe('parseDurationMs - Property 2: Malformed or non-positive durations are rejected', () => {
  it('returns null for any string outside the <number><optional ms|s|m|h> grammar', () => {
    fc.assert(
      fc.property(
        fc
          .oneof(
            // Empty / whitespace-only inputs.
            fc.constantFrom('', ' ', '   ', '\t', '\n'),
            // Hand-picked alphabetic, symbolic, and near-miss garbage that the
            // grammar must reject (verified to never match GRAMMAR).
            fc.constantFrom(
              'abc',
              'ms',
              's',
              'h',
              'minutes',
              '5min',
              '5 s',
              '1.2.3',
              'ten',
              'NaN',
              'Infinity',
              '0x10',
              '1e3',
              '$$$',
              '-',
              '+',
              '.',
              '..',
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

  it('returns null for the literal values undefined and null', () => {
    fc.assert(
      fc.property(fc.constantFrom(undefined, null), (value) => {
        expect((service as any).parseDurationMs(value)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
