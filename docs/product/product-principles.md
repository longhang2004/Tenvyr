# Product Principles

These principles constrain product and architecture decisions. They do not
authorize implementation of roadmap features.

|   # | Principle                                                   | Operational meaning                                                                                                        |
| --: | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
|   1 | Control plane, not another agent framework                  | Own execution decisions, supervision, contracts, and policy; let frameworks implement agent internals.                     |
|   2 | Framework-neutral                                           | No framework becomes the required orchestration model or leaks into core contracts.                                        |
|   3 | Execution contracts are authoritative                       | Versioned invocation/result contracts and persisted state determine execution truth.                                       |
|   4 | Observability is a projection, not transactional state      | Traces may be sampled, delayed, unavailable, or rebuilt without changing execution outcomes.                               |
|   5 | Runtime isolation and supervision over prompt orchestration | Bound resources, lifecycle, cancellation, security, and failure containment before adding prompt convenience.              |
|   6 | Explicit security boundaries                                | Trusted configuration selects transports, callback targets, credentials, policy, and capture; payloads do not.             |
|   7 | Portable telemetry through open standards                   | Prefer OTLP and W3C context, with compatibility layers for evolving conventions.                                           |
|   8 | Privacy by default                                          | Metadata-only is the safe starting point; payload capture requires explicit bounded policy.                                |
|   9 | Durable state for accepted responsibility                   | Once the control plane accepts work, production guarantees require durable execution, callback, and idempotency ownership. |
|  10 | No speculative abstraction without an active use case       | Add an interface, dependency, plugin, or extension point only for a current verified consumer.                             |
|  11 | SDK core remains model-provider neutral                     | Provider SDKs and monkey patches belong in optional versioned packages, never Worker core.                                 |
|  12 | Product identity must avoid ecosystem confusion             | Resolve the current naming collision before public packages, domains, or release claims.                                   |

See the
[observability and provenance roadmap](../roadmap/observability-provenance-roadmap.md)
for phased capabilities and acceptance signals.
