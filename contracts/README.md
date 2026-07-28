# Agent Invocation Contracts v1

This directory is the runtime-independent source of truth for Tenvyr agent messages.

- `schemas/agent-invocation.v1.schema.json` validates dispatched work.
- `schemas/agent-result.v1.schema.json` validates terminal results.
- `schemas/agent-event.v1.schema.json` reserves a typed event shape for future streaming and supervision.
- `schemas/http-agent-run-request.v1.schema.json` wraps an invocation with callback delivery metadata.
- `schemas/http-agent-run-accepted.v1.schema.json` validates asynchronous HTTP acceptance.
- `examples/` contains valid payloads for each schema.
- `conformance/` contains language-neutral valid/invalid wire fixtures,
  deterministic HMAC vectors, callback status expectations, and retry timing
  matrices for Worker SDK implementations.

All schemas use JSON Schema draft 2020-12. Structured values reject unknown fields with
`additionalProperties: false`; only `metadata` accepts extensions. The
`@tenvyr/contracts` package loads these canonical files directly, maps validator output
to `ContractValidationError`, and applies the result status/error semantic rule.

## Compatibility

New writers emit v1. New readers accept v1 and the legacy Kafka payloads described below.
Kafka topic names and agent names are unchanged.

### Legacy invocation mapping

| Legacy field  | AgentInvocationV1                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `executionId` | `executionId`                                                                                            |
| `stepId`      | `stepId`                                                                                                 |
| `agent`       | checked against caller `agent`, then `target.agent`                                                      |
| `input`       | `input`                                                                                                  |
| `attempt`     | checked against caller `attempt`, then `attempt`                                                         |
| `timestamp`   | caller supplies it as `createdAt`                                                                        |
| `timeout`     | converted to `deadlineAt` when it uses `ms`, `s`, `m`, or `h`; preserved under `metadata.legacy.timeout` |
| `maxAttempts` | `metadata.legacy.maxAttempts`                                                                            |

Legacy payloads do not contain `invocationId`, `stepExecutionId`, or trace IDs. The agent
boundary supplies deterministic values from the received execution and step context:

- `stepExecutionId`: `legacy:<executionId>:<stepId>`
- `invocationId`: `legacy:<executionId>:<stepId>:<attempt>`
- `trace.traceId`: `<executionId>`
- `trace.correlationId`: the derived `invocationId`

The normalizer never creates random IDs. Missing or conflicting orchestration context is a
validation error.

The conformance README also defines the expected invocation ID for the
`invocation-mismatch.json` acceptance body. Correlation is a protocol check
performed after JSON Schema validation, so the body remains schema-valid.

### Legacy result mapping

| Legacy field               | AgentResultV1                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `executionId`              | checked against the persisted step, then `executionId`                                              |
| `stepId`                   | used by the Orchestrator to find the persisted step execution; retained in `metadata.legacy.stepId` |
| `status: COMPLETED`        | `status: succeeded`                                                                                 |
| `status: FAILED`           | `status: failed`                                                                                    |
| `output`, otherwise `data` | `output`                                                                                            |
| string `error`             | `error: { code: "LEGACY_AGENT_FAILURE", message, retryable: false }`                                |
| `attempt`                  | `metadata.legacy.attempt`                                                                           |
| `timestamp`                | `completedAt`                                                                                       |

The Orchestrator supplies the persisted step UUID as `stepExecutionId` and derives
`invocationId` as `<stepExecutionId>:<attempt>`. If the legacy timestamp is absent, the Kafka
record timestamp is used. A result that cannot be correlated safely is rejected.
