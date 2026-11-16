#!/usr/bin/env node

/**
 * T08 Review Benchmark Runner.
 *
 * Bounded 100-request / concurrency 4 benchmark against review service.
 * - Reuses existing Smoke HTTP session/login/CSRF helpers.
 * - Authenticates Submitter A and verifies health before measurement.
 * - Issues exactly 100 POST /api/v1/reviews submissions with max 4 in-flight.
 * - Times performance.now per request through complete response body.
 * - Collects raw latencies, computes nearest-rank p50/p95, counts statuses and 503 rejections.
 * - Performs optional bounded drain to observe asynchronous worker progression separately.
 * - Outputs clean JSON evidence with no credentials/tokens/secrets or personal paths.
 * - Supports --self-check for offline verification with zero network/credential dependencies.
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import os from "node:os";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Small fixed safe Java fixture: valid title length, valid syntax, no analysis claims
const BENCHMARK_FIXTURE = {
  title: "Benchmark Submission Fixture",
  language: "java",
  code: "public class BenchmarkFixture { public static void main(String[] args) { /* benchmark load fixture */ } }",
};

// Loopback enforcement guard
function assertLoopbackUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  const hostname = parsed.hostname;
  const isLoopback =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if (!isLoopback) {
    throw new Error(`Security violation: BASE_URL must target a local loopback interface, got: ${hostname}`);
  }
  return parsed.origin;
}

// Explicit nearest-rank percentile definition:
// For ascending sorted list of length N: rank = ceil((p / 100) * N); index = max(0, rank - 1)
function nearestRankPercentile(sortedAsc, p) {
  if (!sortedAsc || sortedAsc.length === 0) return 0;
  const n = sortedAsc.length;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAsc[index];
}

// Bounded concurrency executor with strict pool limit and zero automatic retries
async function runConcurrentExecutor(totalTasks, concurrencyLimit, taskFn) {
  let nextIndex = 0;
  let activeInFlight = 0;
  let maxObservedInFlight = 0;
  const results = new Array(totalTasks);

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= totalTasks) break;

      activeInFlight++;
      if (activeInFlight > maxObservedInFlight) {
        maxObservedInFlight = activeInFlight;
      }

      try {
        results[idx] = await taskFn(idx, activeInFlight);
      } finally {
        activeInFlight--;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrencyLimit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { results, maxObservedInFlight };
}

// Self-check routine: executes offline without network, server, or credentials
async function runSelfCheck() {
  process.stdout.write("[Benchmark Self-Check] Validating percentiles and concurrency logic...\n");

  // 1. Validate nearest-rank percentile calculations
  const sample100 = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(nearestRankPercentile(sample100, 50), 50, "P50 of 1..100 must be 50");
  assert.equal(nearestRankPercentile(sample100, 95), 95, "P95 of 1..100 must be 95");
  assert.equal(nearestRankPercentile(sample100, 99), 99, "P99 of 1..100 must be 99");

  const sample5 = [10, 20, 30, 40, 50];
  assert.equal(nearestRankPercentile(sample5, 50), 30, "P50 of 5 elements must be index 2 (30)");
  assert.equal(nearestRankPercentile(sample5, 95), 50, "P95 of 5 elements must be index 4 (50)");

  // 2. Validate concurrency executor (100 unique tasks, max in-flight <= 4, no retries)
  const executedIndices = [];
  const inFlightRecord = [];
  const { results, maxObservedInFlight } = await runConcurrentExecutor(100, 4, async (idx, inFlight) => {
    executedIndices.push(idx);
    inFlightRecord.push(inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { idx, success: true };
  });

  assert.equal(results.length, 100, "Executor must return exactly 100 results");
  assert.equal(executedIndices.length, 100, "Executor must execute exactly 100 tasks without retries");
  const uniqueSet = new Set(executedIndices);
  assert.equal(uniqueSet.size, 100, "Executor must execute each task index uniquely");
  for (let i = 0; i < 100; i++) {
    assert.ok(uniqueSet.has(i), `Index ${i} must be present in execution set`);
  }
  assert.ok(maxObservedInFlight <= 4, `Max in-flight (${maxObservedInFlight}) must be <= 4`);
  assert.ok(maxObservedInFlight >= 1, "Max in-flight must be >= 1");

  // 3. Validate loopback URL security guard
  assert.equal(assertLoopbackUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(assertLoopbackUrl("http://localhost:18080"), "http://localhost:18080");
  assert.equal(assertLoopbackUrl("http://[::1]:8080"), "http://[::1]:8080");
  assert.throws(() => assertLoopbackUrl("http://example.com:8080"), /Security violation/);
  assert.throws(() => assertLoopbackUrl("http://192.168.1.50:8080"), /Security violation/);

  process.stdout.write("[Benchmark Self-Check] All assertions passed successfully.\n");
}

async function main() {
  const args = process.argv.slice(2);
  const isSelfCheck = args.includes("--self-check");

  if (isSelfCheck) {
    await runSelfCheck();
    process.exit(0);
  }

  // Parse optional CLI arguments
  let outputPath = null;
  let doDrain = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--no-drain") {
      doDrain = false;
    } else if (args[i] === "--drain") {
      doDrain = true;
    }
  }

  if (!outputPath) {
    outputPath = join(ROOT, "docs", "_scratch", "review-benchmark.json");
  }

  // Dynamic import Smoke helpers after self-check to prevent credential-read side effects when offline
  const smoke = await import("./review-smoke.mjs");
  const baseUrl = assertLoopbackUrl(smoke.BASE_URL);
  const client = new smoke.TestHttpClient();

  process.stdout.write(`[Benchmark] Initializing against ${baseUrl} (mode: MOCK)...\n`);

  // 1. Verify health probe
  const healthRes = await client.fetch(`${baseUrl}/actuator/health`, { timeout: 5000 });
  if (healthRes.status !== 200) {
    process.stderr.write(`[Benchmark] Health check failed with HTTP ${healthRes.status}\n`);
    process.exit(1);
  }

  // 2. Authenticate Submitter A
  let csrf;
  try {
    csrf = await smoke.login(client, smoke.submitterA);
  } catch (err) {
    process.stderr.write(`[Benchmark] Authentication failed: ${err.message}\n`);
    process.exit(1);
  }

  const meRes = await client.fetch(`${baseUrl}/api/v1/me`, { timeout: 5000 });
  if (meRes.status !== 200) {
    process.stderr.write(`[Benchmark] Verification of /api/v1/me failed with HTTP ${meRes.status}\n`);
    process.exit(1);
  }
  const me = await meRes.json();
  if (me.role !== "SUBMITTER") {
    process.stderr.write(`[Benchmark] Submitter role mismatch: expected SUBMITTER, got ${me.role}\n`);
    process.exit(1);
  }

  // Fresh CSRF token for benchmark batch
  const freshCsrf = await smoke.getCsrf(client);

  const TOTAL_SUBMISSIONS = 100;
  const CONCURRENCY_LIMIT = 4;
  process.stdout.write(`[Benchmark] Executing ${TOTAL_SUBMISSIONS} POST /api/v1/reviews submissions (concurrency: ${CONCURRENCY_LIMIT})...\n`);

  let unexpectedErrorOccurred = false;
  const wallStart = performance.now();

  const { results: samples, maxObservedInFlight } = await runConcurrentExecutor(
    TOTAL_SUBMISSIONS,
    CONCURRENCY_LIMIT,
    async (taskIndex, inFlight) => {
      const idempotencyKey = randomUUID();
      const reqStart = performance.now();
      let status = 0;
      let retryAfter = null;
      let location = null;
      let requestId = null;
      let errorMessage = null;

      try {
        const res = await client.fetch(`${baseUrl}/api/v1/reviews`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            [freshCsrf.headerName]: freshCsrf.token,
          },
          body: JSON.stringify(BENCHMARK_FIXTURE),
          timeout: 10000,
        });

        status = res.status;
        retryAfter = res.headers.get("retry-after");
        location = res.headers.get("location");
        const bodyText = await res.text();

        if (status === 202) {
          try {
            const parsed = JSON.parse(bodyText);
            requestId = parsed.id || null;
          } catch {}
        } else if (status === 503) {
          // Legitimate server rejection (backpressure / capacity bound)
        } else {
          // Unexpected response (auth failure, validation bug, internal server error)
          unexpectedErrorOccurred = true;
          errorMessage = `Unexpected HTTP status ${status}`;
        }
      } catch (err) {
        unexpectedErrorOccurred = true;
        errorMessage = err.message;
      }

      const reqEnd = performance.now();
      const latencyMs = Number((reqEnd - reqStart).toFixed(3));

      return {
        sampleIndex: taskIndex,
        idempotencyKey,
        status,
        retryAfter,
        location,
        requestId,
        latencyMs,
        inFlight,
        error: errorMessage,
      };
    }
  );

  const wallEnd = performance.now();
  const totalElapsedMs = Number((wallEnd - wallStart).toFixed(3));

  // Compute status tallies and metrics
  const statusCounts = {};
  const acceptedIds = [];
  let rejectionCount = 0;

  for (const sample of samples) {
    statusCounts[sample.status] = (statusCounts[sample.status] || 0) + 1;
    if (sample.status === 202 && sample.requestId) {
      acceptedIds.push(sample.requestId);
    }
    if (sample.status === 503) {
      rejectionCount++;
    }
  }

  const sortedLatencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const p50 = nearestRankPercentile(sortedLatencies, 50);
  const p95 = nearestRankPercentile(sortedLatencies, 95);
  const p99 = nearestRankPercentile(sortedLatencies, 99);
  const minLatency = sortedLatencies[0] || 0;
  const maxLatency = sortedLatencies[sortedLatencies.length - 1] || 0;
  const meanLatency = Number(
    (sortedLatencies.reduce((sum, v) => sum + v, 0) / sortedLatencies.length).toFixed(3)
  );

  const requestsPerSec = Number(((TOTAL_SUBMISSIONS / totalElapsedMs) * 1000).toFixed(2));
  const acceptedPerSec = Number(((acceptedIds.length / totalElapsedMs) * 1000).toFixed(2));
  const rejectionRate = Number((rejectionCount / TOTAL_SUBMISSIONS).toFixed(4));

  // 3. Optional bounded drain / projection check for accepted submissions
  let asynchronousDrain = null;
  if (doDrain && acceptedIds.length > 0) {
    process.stdout.write(`[Benchmark] Performing bounded drain check on ${acceptedIds.length} accepted submissions...\n`);
    const drainDeadline = Date.now() + 5000;
    const drainCounts = { UNKNOWN: 0 };

    for (const id of acceptedIds) {
      if (Date.now() > drainDeadline) break;
      try {
        const pollRes = await client.fetch(`${baseUrl}/api/v1/reviews/${id}`, { timeout: 1000 });
        if (pollRes.status === 200) {
          const detail = await pollRes.json();
          const st = detail.status || "UNKNOWN";
          drainCounts[st] = (drainCounts[st] || 0) + 1;
        } else {
          drainCounts.UNKNOWN = (drainCounts.UNKNOWN || 0) + 1;
        }
      } catch {
        drainCounts.UNKNOWN = (drainCounts.UNKNOWN || 0) + 1;
      }
    }

    const inspectedAcceptedCount = Object.values(drainCounts).reduce((sum, c) => sum + c, 0);
    asynchronousDrain = {
      note: "Asynchronous background worker progression measured separately from submission API latency; no SLA claim",
      boundedTimeoutMs: 5000,
      inspectedAcceptedCount,
      uninspectedAcceptedCount: acceptedIds.length - inspectedAcceptedCount,
      statusCounts: drainCounts,
    };
  }

  // Construct structured evidence JSON (sanitized: no personal paths, no credentials/tokens)
  const evidence = {
    benchmark: "review-submission-bounded",
    testMode: "MOCK",
    timestamp: new Date().toISOString(),
    sourceRevision: process.env.SOURCE_REVISION || "unspecified",
    environment: {
      nodeVersion: process.version,
      platform: os.platform(),
      kernelRelease: os.release(),
      cpuCount: os.cpus().length,
    },
    configuredBounds: {
      disclaimer: "CONFIGURED resource bounds from application.yml and compose topology; NOT a capacity SLA or throughput guarantee",
      tomcat: { maxThreads: 50, acceptCount: 50 },
      hikari: { maximumPoolSize: 10, connectionTimeoutMs: 2000 },
      worker: { concurrency: 2, queueCapacity: 16 },
    },
    percentileMethod: "nearest-rank: index = Math.min(Math.max(Math.ceil((p / 100) * N) - 1, 0), N - 1) on ascending sorted latencies",
    metrics: {
      totalSubmissions: TOTAL_SUBMISSIONS,
      concurrencyLimit: CONCURRENCY_LIMIT,
      maxObservedInFlight,
      totalElapsedMs,
      observedRequestsPerSec: requestsPerSec,
      acceptedCount: acceptedIds.length,
      observedAcceptedPerSec: acceptedPerSec,
      rejectionCount,
      rejectionRate,
      statusCounts,
      latencyMs: {
        min: minLatency,
        mean: meanLatency,
        p50,
        p95,
        p99,
        max: maxLatency,
      },
    },
    asynchronousDrain,
    samples,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2), "utf8");
  process.stdout.write(`[Benchmark] Evidence JSON written to ${outputPath}\n`);

  // Small console summary
  process.stdout.write(`\n--- Benchmark Summary ---\n`);
  process.stdout.write(`Mode: ${evidence.testMode}\n`);
  process.stdout.write(`Requests: ${TOTAL_SUBMISSIONS} (concurrency: ${CONCURRENCY_LIMIT}, max in-flight: ${maxObservedInFlight})\n`);
  process.stdout.write(`Elapsed: ${totalElapsedMs} ms\n`);
  process.stdout.write(`Observed Throughput: ${requestsPerSec} req/s (Accepted: ${acceptedPerSec} req/s)\n`);
  process.stdout.write(`Statuses: ${JSON.stringify(statusCounts)}\n`);
  process.stdout.write(`Rejections (503): ${rejectionCount} (rate: ${(rejectionRate * 100).toFixed(1)}%)\n`);
  process.stdout.write(`Latency: p50 = ${p50} ms, p95 = ${p95} ms, mean = ${meanLatency} ms\n`);
  if (asynchronousDrain) {
    process.stdout.write(`Asynchronous Worker Drain Statuses: ${JSON.stringify(asynchronousDrain.statusCounts)}\n`);
  }
  process.stdout.write(`-------------------------\n`);

  if (unexpectedErrorOccurred) {
    process.stderr.write("[Benchmark] Run invalid due to unexpected auth, validation, or server errors.\n");
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[Benchmark] Fatal: ${err.message}\n`);
  process.exit(1);
});
