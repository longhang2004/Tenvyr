# `@tenvyr/contracts`

TypeScript types, validators, and compatibility helpers for the
language-neutral Tenvyr invocation, result, and HTTP Worker protocol.

The package remains private until the owner completes registry, license, legal,
and release gates. Import only from the package root:

```typescript
import {
  parseAgentInvocation,
  type AgentInvocationV1,
} from "@tenvyr/contracts";
```

Repository conformance fixtures remain under `contracts/conformance`; they are
development inputs for language SDKs and are not runtime package content. The
five JSON Schemas are copied into `dist/schema-json` during build because the
runtime validators require them.

See the current [agent protocol](../../docs/architecture/contracts/agent-protocol-v1.md)
and [JSON interoperability policy](../../docs/architecture/contracts/json-interoperability.md).
