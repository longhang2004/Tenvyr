---
title: "T05 — Reuse AgentProcessor in a strict HTTP review Worker"
status: planned
audience:
  - developer
last_verified: 2026-11-11
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T05: Reuse AgentProcessor in a strict HTTP review Worker

Dependencies: T03 (including T02 contracts). Estimate: 4–6 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: planned, not implemented.

## Deliverable and files

Create plain-Java module `backend/review-worker` with `pom.xml`,
`src/main/java/io/tenvyr/reviewworker/ReviewWorkerMain.java`,
`StrictReviewRunner.java`, and focused executable checks under src/test.
Reuse existing AgentProcessor and Worker. A bounded Runner HTTP factory may be
exposed in AgentProcessor; preserve its legacy constructor/parser behavior and
legacy tests. Integrator registers this module/root runner changes serially
when merging parallel T04/T05 work.

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
Agent identity is exactly code-reviewer. Modes: MOCK (default, injected canned
demo Runner) and RUNNER (explicit fixed private existing Java Runner URL).

## References to copy

Read full AgentProcessor.process/parseOutput, AgentCheck's injected Runner,
Worker.Context.success/fail and WorkerConfig.freeze. Keep canonical invocation/
result correlation. Do not copy NestJS-shaped mock heuristics as Java analysis.

## Steps and acceptance

- [ ] Add failing checks for strict raw output: plaintext, malformed JSON,
  missing/wrong score/findings, out-of-range score, oversize body and excessive
  findings. Assert failure instead of legacy score 80/90. Also preserve metadata.
- [ ] Wrap the Runner BEFORE AgentProcessor's lenient parseOutput; validate
  bounded `data.output` as strict JSON via ReviewReportContract. Revalidate
  business output. Do not return an entire AgentResult inside Worker output.
  Map failed/timed-out processor results into `context.fail` with truthful
  retryable flags; Worker alone signs and constructs the outer result.
- [ ] MOCK returns a fixed valid demo report with mode MOCK,
  provider=mock/model=demo-fixture and usageSource=unavailable; it explicitly
  states no real source/security analysis occurred. It works for any bounded
  input without pretending to detect a vulnerability. Preserve this label
  through persisted result and API report.
- [ ] RUNNER uses the existing private Java Runner protocol and actual
  metadata. Reuse/expose its HTTP factory with a bounded overload if needed;
  reject redirects, cap response bytes at 1 MiB and respect the remaining
  invocation deadline. No credentials/live model in tests and no silent
  switch from a failed real call to MOCK.
- [ ] Host with existing Worker: concurrency=2, maxQueuedRuns=16,
  maxRequestBytes=1 MiB, maxResponseBytes=65,536; Bearer admission, exact
  callback origin allow-list and existing callback HMAC keys. Permit insecure
  HTTP only in explicit loopback/Compose demo mode. Shutdown uses Worker.close.
- [ ] Run real loopback integration: 202 submit -> one signed result with
  correct invocation/execution/step identity. Verify retryable failure,
  callback duplicate and worker restart behavior without claiming durable
  Worker storage or exactly-once compute.
- [ ] Extend review-checks runner to execute the module's tests explicitly;
  ensure no Kafka connection is attempted. Run retained AgentCheck/WorkerCheck
  and review gates, docs/ledger updates, verifiers, and handoff.

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
