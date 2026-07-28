# `@tenvyr/worker`

TypeScript SDK for implementing an asynchronous Tenvyr HTTP worker. It
accepts `AgentInvocationV1` submissions, runs a typed handler, and delivers the
terminal `AgentResultV1` to the Orchestrator through an HMAC-signed callback.

## Installation

The package is currently private to this workspace:

```bash
pnpm add @tenvyr/worker@workspace:*
```

The SDK depends only on the public API of `@tenvyr/contracts` and Node.js
HTTP primitives.

Do not publish this package. The Tenvyr identity is approved for local
repository implementation, but registry, domain, license, legal, and public
release gates remain owner actions. The current manifest is pack-ready only so
release contents and external installation can be verified before publication.

## Minimal worker

```ts
import { createTenvyrWorker, defineAgent } from "@tenvyr/worker";

const agent = defineAgent({
  name: "word-counter",
  execute: async (_context, input: unknown) => ({
    count: String(input).split(/\s+/).length,
  }),
});

const worker = createTenvyrWorker({
  agent,
  authentication: {
    bearerToken: process.env.TENVYR_BEARER_TOKEN!,
  },
  callbackAuthentication: {
    keys: {
      [process.env.TENVYR_CALLBACK_KEY_ID!]:
        process.env.TENVYR_CALLBACK_SECRET!,
    },
  },
  callbackPolicy: {
    allowedOrigins: [process.env.TENVYR_CALLBACK_ORIGIN!],
  },
});

const address = await worker.start();
console.log(`Listening on http://${address.host}:${address.port}`);
```

`start()` defaults to `127.0.0.1:8080`. Calling it again while the worker is
running returns the same address. After `stop()`, the worker is terminal and
cannot be restarted.

## Typed input and output

A parser can be a function or an object with a `parse(value)` method, including
Zod-like parsers:

```ts
const inputParser = (value: unknown): { text: string } => {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { text?: unknown }).text !== "string"
  ) {
    throw new Error("Expected { text: string }");
  }
  return value as { text: string };
};

const agent = defineAgent({
  name: "uppercase",
  inputParser,
  outputParser: {
    parse(value: unknown) {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { text?: unknown }).text !== "string"
      ) {
        throw new Error("Expected { text: string }");
      }
      return value as { text: string };
    },
  },
  execute: async (_context, { text }) => ({ text: text.toUpperCase() }),
});
```

Direct handler returns are always raw output. Only
`context.success({ output, ...options })` creates a structured success:

```ts
const structuredAgent = defineAgent({
  name: "structured-agent",
  execute: async (context, input: unknown) =>
    context.success({
      output: { accepted: input },
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      metadata: { model: "example" },
    }),
});
```

A raw object such as `{ output: "value" }` remains the handler output and is
not treated as a structured result.

## Explicit failures

Use `context.fail()` for a safe, intentional agent failure:

```ts
const validatingAgent = defineAgent({
  name: "validating-agent",
  execute: async (context, input: unknown) => {
    if (!input) {
      context.fail({
        code: "INVALID_INPUT",
        message: "Input is required",
        retryable: false,
        details: { field: "input" },
      });
    }
    return input;
  },
});
```

Unexpected exceptions become a sanitized `AGENT_EXECUTION_FAILED` result. Their
original message and stack are never sent in the callback.

## Timeout and cancellation

Every execution receives a cooperative `AbortSignal`:

```ts
const abortAwareAgent = defineAgent({
  name: "abort-aware-agent",
  execute: async (context) => {
    const response = await fetch("https://service.internal/data", {
      signal: context.signal,
    });
    return response.json();
  },
});
```

The signal aborts when the configured execution timeout expires or shutdown
cancels the run. A handler must pass the signal to abort-aware work or check
`context.signal.aborted` itself. Late handler completion is ignored after the
worker has selected a terminal result.

JavaScript cannot forcibly stop synchronous code or a promise that ignores the
signal. After the grace deadline, the Worker stops awaiting that handler,
selects `cancelled`, and prevents the handler's late completion from producing
another result.

## Configuration

Required values:

| Setting                                  | Environment example      | Purpose                                    |
| ---------------------------------------- | ------------------------ | ------------------------------------------ |
| `authentication.bearerToken`             | `TENVYR_BEARER_TOKEN`    | Authenticates `POST /v1/runs`              |
| `callbackAuthentication.keys[keyId]`     | `TENVYR_CALLBACK_SECRET` | Selects and stores callback signing keys   |
| `callbackPolicy.allowedOrigins`          | `TENVYR_CALLBACK_ORIGIN` | Exact normalized callback origin allowlist |
| callback key ID used by the Orchestrator | `TENVYR_CALLBACK_KEY_ID` | Selects one configured signing key         |

Defaults are concurrency `4`, queue size `100`, execution timeout `15 minutes`,
idempotency TTL `24 hours`, `10,000` records, callback attempts `8`, callback
backoff `500 ms` to `30 seconds`, jitter `0.2`, callback request timeout
`10 seconds`, and shutdown grace `30 seconds`.

HTTPS callbacks are required. Development HTTP callbacks require both
`callbackPolicy.allowInsecureHttp: true` and an exact allowlisted HTTP origin.
Callback URLs with credentials, a query, or a fragment are rejected.

## Health endpoints

- `GET /health/live` returns `200` while the process is alive.
- `GET /health/ready` returns `200` only while submissions can be accepted.
- `POST /v1/runs` accepts authenticated canonical run requests.

The worker returns `202` before scheduling the handler. Queue saturation,
idempotency capacity exhaustion, or shutdown returns a bounded safe error
without reading or logging handler input/output.

## Idempotency and callback lifecycle

The in-memory idempotency fingerprint is SDK-local behavior, not a wire
protocol requirement. It sorts JSON object keys without losing special keys
such as `__proto__`, and it includes request input, callback URL, and callback
key ID. Semantic duplicates return the original `runId` and `acceptedAt`;
conflicts return `409`.

Accepted queued runs become cancellation callbacks when shutdown begins.
Active work and callbacks may drain during grace. At force shutdown, one
worker-wide signal aborts executions, callback requests, response reads, and
retry sleeps—including callback work created after the deadline. `stop()`
does not resolve until tracked callback work settles, and repeated calls are
idempotent. Callback retry attempts use current Unix seconds, so two attempts
in one second may have the same timestamp/signature while retaining one stable
delivery ID and body.

## Package verification

Run:

```bash
pnpm verify:package-packs
```

The smoke script builds and packs contracts and Worker, enforces a tarball
allowlist, verifies the exact contracts version rewrite, installs both
tarballs in a temporary project outside the workspace, compiles a TypeScript
consumer, blocks deep imports, starts the packed Worker, checks
`/health/live`, and stops it without publishing.

## Production deployment

- Put the worker behind TLS or a trusted TLS-terminating proxy.
- Store bearer and HMAC secrets in the deployment secret manager.
- Configure only exact Orchestrator callback origins.
- Use the health endpoints for readiness and liveness probes.
- Wire `SIGTERM` and `SIGINT` in the application, then await `worker.stop()`.

The SDK does not install signal handlers. It keeps queue, idempotency, and
callback delivery state in memory, so a process restart loses that state.

## Troubleshooting

- `401`: verify the bearer token; the response always includes
  `WWW-Authenticate: Bearer`.
- `415`: send `Content-Type: application/json`.
- `429`: execution queue or safe idempotency capacity is full.
- `503`: the worker is starting, stopping, or stopped.
- Callback failures: verify the exact callback origin, HMAC key ID/secret, TLS
  configuration, and the Orchestrator callback response.

See
[`docs/architecture/typescript-worker-sdk.md`](../../docs/architecture/typescript-worker-sdk.md)
and [`contracts/conformance`](../../contracts/conformance) for the complete
wire contract. Future observability and provenance direction is in the
[roadmap](../../docs/roadmap/observability-provenance-roadmap.md).
