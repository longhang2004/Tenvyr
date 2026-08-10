import type {
  AgentEventType,
  AgentEventV1,
  AgentInvocationV1,
  JsonValue,
} from "@tenvyr/contracts";
import { asJsonValue } from "../execution/json-value";
import { canonicalJson } from "../invocation/canonical-json";
import { safeLogger } from "../observability/safe-logger";
import type { WorkerLogger } from "../public/types";

/**
 * Upper bound on the canonical JSON size of an event payload.
 * Payloads whose canonical JSON exceeds this limit are rejected.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

/**
 * Per-invocation event machinery. Owns the monotonic sequence counter and
 * builds each event body exactly once; the same body is reused across every
 * delivery retry of that event. When disabled, all emissions are no-ops.
 */
export class RunEventEmitter {
  readonly enabled: boolean;

  private sequence = 0;
  private readonly invocation: AgentInvocationV1;
  private readonly runId: string;
  private readonly logger: WorkerLogger;
  private readonly deliver: (event: AgentEventV1, rawBody: Buffer<ArrayBuffer>) => void;  private readonly now: () => number;
  private debugNoted = false;

  constructor(options: {
    invocation: AgentInvocationV1;
    runId: string;
    enabled: boolean;
    logger: WorkerLogger;
    deliver: (event: AgentEventV1, rawBody: Buffer<ArrayBuffer>) => void;
    now?: () => number;
  }) {
    this.invocation = options.invocation;
    this.runId = options.runId;
    this.enabled = options.enabled;
    this.logger = safeLogger(options.logger);
    this.deliver = options.deliver;
    this.now = options.now ?? Date.now;
  }

  /**
   * Create and deliver one event. `eventId` is deterministic
   * (`${invocationId}:${sequence}`) and stable across delivery retries.
   * The canonical body is built once here and reused by the delivery layer.
   */
  emit(
    type: AgentEventType,
    payload: Record<string, JsonValue>,
  ): void {
    if (!this.enabled) {
      if (!this.debugNoted) {
        this.debugNoted = true;
        this.logger.debug(
          "Agent events are disabled; ignoring event emission",
          {
            agent: this.invocation.target.agent,
            invocationId: this.invocation.invocationId,
            runId: this.runId,
            eventType: type,
          },
        );
      }
      return;
    }
    const validated = validateEventPayload(payload);
    const sequence = this.sequence;
    this.sequence += 1;
    const event: AgentEventV1 = {
      schemaVersion: "1",
      eventId: `${this.invocation.invocationId}:${sequence}`,
      invocationId: this.invocation.invocationId,
      executionId: this.invocation.executionId,
      stepExecutionId: this.invocation.stepExecutionId,
      sequence,
      type,
      occurredAt: new Date(this.now()).toISOString(),
      payload: validated,
      trace: {
        traceId: this.invocation.trace.traceId,
        correlationId: this.invocation.trace.correlationId,
      },
      metadata: { runId: this.runId },
    };
    const rawBody = Buffer.from(JSON.stringify(event), "utf8");
    this.deliver(event, rawBody);
  }
}

function validateEventPayload(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Agent event payload must be a JSON object");
  }
  let json: JsonValue;
  try {
    json = asJsonValue(payload, "$");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Agent event payload is not valid JSON: ${message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new TypeError("Agent event payload must be a JSON object");
  }
  const size = Buffer.byteLength(canonicalJson(json), "utf8");
  if (size > MAX_EVENT_PAYLOAD_BYTES) {
    throw new RangeError(
      `Agent event payload exceeds the ${MAX_EVENT_PAYLOAD_BYTES}-byte limit`,
    );
  }
  return json as Record<string, JsonValue>;
}
