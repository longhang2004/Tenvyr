#!/usr/bin/env node
/**
 * M11 closure: executable guard for the real-PostgreSQL CI runs.
 *
 * Parses a jest summary log and FAILS when the suite silently skipped the
 * Postgres integration coverage — e.g. because TEST_DATABASE_URL was
 * missing (the describeWithPostgres suites would have been skipped) or
 * because an unexpected number of tests were skipped. Required closure
 * tests must never silently `describe.skip`.
 *
 * Usage: node scripts/assert-jest-run.mjs <log-file> [min-passed] [max-skipped]
 *   min-passed  default 900   minimum "Tests: N passed" count
 *   max-skipped default 20    maximum acceptable skipped count (the 10
 *                             opt-in TENVYR_LIVE_RUNTIME_GATES probes plus
 *                             a small margin)
 */
import { readFileSync } from "node:fs";

const [logPath, minPassedRaw, maxSkippedRaw] = process.argv.slice(2);
const minPassed = Number(minPassedRaw ?? 900);
const maxSkipped = Number(maxSkippedRaw ?? 20);
if (!logPath) {
  console.error("usage: assert-jest-run.mjs <log-file> [min-passed] [max-skipped]");
  process.exit(2);
}
const log = readFileSync(logPath, "utf8");
const summary = log.match(/Tests:\s+(\d+) skipped,\s+(\d+) passed/);
if (!summary) {
  console.error("FAIL: no jest summary found in the log — did the suite run at all?");
  process.exit(1);
}
const skipped = Number(summary[1]);
const passed = Number(summary[2]);
const failures = [];
if (passed < minPassed) {
  failures.push(`passed=${passed} < required ${minPassed}`);
}
if (skipped > maxSkipped) {
  failures.push(`skipped=${skipped} > allowed ${maxSkipped} (a missing TEST_DATABASE_URL would silently skip the Postgres suites)`);
}
if (failures.length > 0) {
  console.error(`FAIL: postgres integration run guard: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`ok: postgres integration run guard (skipped=${skipped}, passed=${passed})`);
