---
title: "T05 — Reuse AgentProcessor in a strict HTTP review Worker"
status: historical
audience:
  - developer
last_verified: 2026-11-14
superseded_by:
  - docs/architecture/review-service.md
sources:
  - backend/review-worker/src/main/java/io/tenvyr/reviewworker/ReviewWorkerMain.java
  - backend/review-worker/src/main/java/io/tenvyr/reviewworker/StrictReviewRunner.java
  - backend/agents/src/main/java/io/tenvyr/agents/AgentProcessor.java
  - backend/review-worker/src/test/java/io/tenvyr/reviewworker/StrictReviewRunnerTest.java
  - backend/review-worker/src/test/java/io/tenvyr/reviewworker/ReviewWorkerConfigurationTest.java
  - backend/review-worker/src/test/java/io/tenvyr/reviewworker/ReviewWorkerIntegrationTest.java
---

# T05: Reuse AgentProcessor in a strict HTTP review Worker

Dependencies: T03 (including T02 contracts). Estimate: 4–6 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md), [VERIFY](../VERIFY.md), [report](../reports/T05.md), and [Review Worker Architecture](../../../../architecture/workers/review-worker.md) first.
Status: ACCEPTED (2026-11-14 Asia/Saigon).

## Deliverable and files

Create plain-Java module `backend/review-worker` with `pom.xml`,
`src/main/java/io/tenvyr/reviewworker/ReviewWorkerMain.java`,
`StrictReviewRunner.java`, and focused executable checks under src/test.
Reuse existing AgentProcessor and Worker. A bounded Runner HTTP factory is
exposed in AgentProcessor; legacy constructor/parser behavior and
legacy tests are preserved unchanged. Integrator registers this module and root
runner changes serially when merging parallel T04/T05 work.

## Interfaces

Consumes existing AgentProcessor.Runner, ReviewReportContract.requireOutput,
Worker/WorkerConfig and protocol v1. Produces:
```java
new StrictReviewRunner(AgentProcessor.Runner delegate)
JsonNode StrictReviewRunner.run(String prompt, ObjectNode context,
                               long timeoutMillis) throws Exception
// Worker handler maps processor result to context.success(...) or context.fail(...)
```

Entry point accepts fixed environment configuration, not user commands/URLs.
Agent identity is exactly `code-reviewer`. Modes: MOCK (default, injected canned
demo Runner) and RUNNER (explicit fixed private existing Java Runner URL).

## References to copy

Read full AgentProcessor.process/parseOutput, AgentCheck's injected Runner,
Worker.Context.success/fail and WorkerConfig.freeze. Keep canonical invocation/
result correlation. Do not copy NestJS-shaped mock heuristics as Java analysis.

## Steps and acceptance

- [x] Add failing checks for strict raw output: plaintext, malformed JSON,
  missing/wrong score/findings, out-of-range score, oversize body and excessive
  findings. Assert failure instead of legacy score 80/90. Also preserve metadata.
- [x] Wrap the Runner BEFORE AgentProcessor's lenient parseOutput; validate
  bounded `data.output` as strict JSON via ReviewReportContract. Revalidate
  business output. Do not return an entire AgentResult inside Worker output.
  Map failed/timed-out processor results into `context.fail` with truthful
  retryable flags; Worker alone signs and constructs the outer result.
- [x] MOCK returns a fixed valid demo report with mode MOCK,
  provider=mock/model=demo-fixture and usageSource=unavailable; it explicitly
  states no real source/security analysis occurred. It works for any bounded
  input without pretending to detect a vulnerability. Preserve this label
  through persisted result and API report.
- [x] RUNNER uses the existing private Java Runner protocol and actual
  metadata. Reuse/expose its HTTP factory with a bounded overload if needed;
  reject redirects, cap response bytes at 1 MiB and respect the remaining
  invocation deadline. No credentials/live model in tests and no silent
  switch from a failed real call to MOCK.
- [x] Host with existing Worker: concurrency=2, maxQueuedRuns=16,
  maxRequestBytes=1 MiB, maxResponseBytes=65,536; Bearer admission, exact
  callback origin allow-list and existing callback HMAC keys. Permit insecure
  HTTP only in explicit loopback/Compose demo mode. Shutdown uses Worker.close.
- [x] Run real loopback integration: 202 submit -> one signed result with
  correct invocation/execution/step identity. Verify retryable failure,
  callback duplicate and worker restart behavior without claiming durable
  Worker storage or exactly-once compute.
- [x] Extend review-checks runner to execute the module's tests explicitly;
  ensure no Kafka connection is attempted. Run retained AgentCheck/WorkerCheck
  and review gates, docs/ledger updates, verifiers, and handoff.

## Verification evidence

- **Isolated Reactor**: `mvn -B -f docs/_scratch/agy/T05/reactor.xml -pl :review-worker -am test` PASS (45 tests: 11 configuration + 13 loopback + 21 strict, failures/errors/skips 0, 2026-11-14T12:00:24Z / Asia/Saigon 19:00:24, 51.639s; logs `null-metadata-fix-test.log` / `.exit0`).
- **Backend Full Build**: `scripts/backend-build.sh` PASS (2m50s, `retained-build.log`).
- **Backend Pure Checks**: `env -u JAVA_TOOL_OPTIONS sh scripts/backend-checks.sh pure` PASS all 9 programs (Foundation 5095, Control 34, Engine 59, Runtime 6, Gateway 115, Agent 95, Worker conformance, Executor host, Operations 67; `retained-pure-no-banner.log` / `.exit0`). Initial pure failure was caused solely by banner on stdout; unsetting env reproduced pure PASS. PostgreSQL retains UTC via explicit JVM settings.
- **Focused Post-Repair AGY Review**: Conversation `3c9e97a0-803b-44c0-8022-15ea28b7bcee` found 0 actionable defects (file review only).
- **Metadata Handling**: Null legacy metadata is normalized to absence only in `StrictReviewRunner`; shared `AgentProcessor` is unchanged beyond its bounded factory.
- **Status**: ACCEPTED. Final root acceptance completed (combined integration 89 Surefire + 73 real PostgreSQL ITs pass in 5m24s finished 2026-11-14T13:27:09Z).

Representative assertions:
```java
assertFalse(malformedResult.path("status").asText().equals("succeeded"));
assertEquals("MOCK", report.evidence().mode());
assertEquals(expectedInvocationId, deliveredResult.path("invocationId").asText());
```

## Reject conditions

No new agent framework, provider SDK, copied unvalidated heuristic, Git/shell/
path execution, Kafka process, nested result envelope, mock presented as real,
or broad changes to every SDK. Worker process-local limitations remain
documented; pure work may repeat after a crash.
