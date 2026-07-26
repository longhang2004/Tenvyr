# TypeScript Worker SDK Implementation Plan

> **For agentic workers:** Implement inline with `superpowers:executing-plans`; use strict
> red-green-refactor for every behavior and `superpowers:verification-before-completion`
> before reporting completion.

**Goal:** Add language-neutral HTTP conformance fixtures and a standalone
`@agentweave/worker` package matching AgentWeave HTTP protocol v1.

**Architecture:** A native Node HTTP boundary feeds a bounded in-memory idempotency store and
FIFO scheduler. Execution maps one handler outcome to one validated result, then an isolated
callback client signs exact bytes and performs bounded retry. Only public
`@agentweave/contracts` exports cross the package boundary.

**Tech stack:** Node.js 20+, TypeScript 5.9, CommonJS, Jest 29, ts-jest, native `http`,
`crypto`, `fetch`, `AbortController`.

## Global constraints

- Preserve all existing uncommitted Prompt 01–03 changes.
- Do not change Orchestrator protocol v1, Kafka, database, frontend, or Java runner behavior.
- Do not add NestJS, KafkaJS, model-provider SDKs, Zod, or a large HTTP framework.
- Do not commit or push.
- Keep runtime state and secrets private.

## Tasks

1. Add every required conformance fixture and a contracts test loader independent of the
   process working directory. Verify invalid/valid parsing, raw-byte signatures, status
   behavior, and retry classification.
2. Scaffold `@agentweave/worker`, exact public exports, strict declarations, public consumer
   compile coverage, and dependency-direction guards.
3. Add failing tests then implement configuration defaults/validation, safe logger, bearer
   authentication, callback origin policy, canonical JSON, and bounded idempotency.
4. Add failing real-HTTP tests then implement health/submission routes, body limits,
   acceptance correlation, duplicate/conflict behavior, and queue capacity.
5. Add failing scheduler/execution tests then implement FIFO concurrency, parsers,
   `context.success`, `context.fail`, JSON compatibility, timeout, cancellation, and
   single-terminal result mapping.
6. Add HMAC-vector and delivery tests then implement exact-byte signing, bounded response
   reading, retry classification/backoff/jitter/Retry-After, stable delivery IDs, fresh
   signatures, and safe exhaustion hooks.
7. Add lifecycle tests then implement one-shot startup, idempotent start/stop, graceful drain,
   queued cancellation, grace-expiry abort, and resource cleanup.
8. Add the runnable TypeScript example, Orchestrator↔Worker loopback integration, architecture
   documentation, package README, root documentation updates, and smoke coverage.
9. Run targeted and repository-wide tests, typechecks, builds, formatting checks, lint where
   non-interactive, dependency guards, open-handle checks, Docker availability check, and
   `git diff --check`.
