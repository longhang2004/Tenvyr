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
 * Upper bound on the canonical JSON size of the COMPLETE AgentEventV1 body
 * (envelope fields included), mirroring the Orchestrator's durable event
 * limit. Events whose canonical body exceeds this limit are rejected locally
 * and never scheduled for delivery, so an official Worker can never emit an
 * event the Orchestrator would permanently reject as oversized.
 */
export const MAX_AGENT_EVENT_CANONICAL_BYTES = 64 * 1024;

/**
 * Upper bound on the generated AgentEvent identity, mirroring the canonical
 * AgentEventV1 contract and the durable varchar(255)/integer storage:
 * `${invocationId}:${sequence}` may be at most 255 characters and sequence is
 * bounded by PostgreSQL int32. An official Worker must never schedule an
 * event whose generated identity the canonical contract would reject.
 */
export const MAX_AGENT_EVENT_ID_LENGTH = 255;
export const MAX_AGENT_EVENT_SEQUENCE = 2147483647;

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
  private readonly deliver: (
    event: AgentEventV1,
    rawBody: Buffer<ArrayBuffer>,
  ) => void;
  private readonly now: () => number;
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
  emit(type: AgentEventType, payload: Record<string, JsonValue>): void {
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
    const eventId = `${this.invocation.invocationId}:${sequence}`;
    // Generated identity bounds: a contract-valid invocation can carry a long
    // invocationId, so the constructed eventId must be checked here. A
    // generated identity outside the canonical AgentEventV1 bounds throws
    // before any delivery callback is scheduled.
    assertAgentEventIdentity(eventId, sequence);
    const event: AgentEventV1 = {
      schemaVersion: "1",
      eventId,
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
    // The 64 KiB size authority is the COMPLETE canonical event body — the
    // same measurement the Orchestrator applies before durable application.
    // A locally oversized event throws before any delivery callback is
    // scheduled; it is never sent to the Orchestrator to be 400-rejected.
    const canonicalSize = Buffer.byteLength(canonicalJson(event), "utf8");
    if (canonicalSize > MAX_AGENT_EVENT_CANONICAL_BYTES) {
      throw new RangeError(
        `Agent event canonical body exceeds the ${MAX_AGENT_EVENT_CANONICAL_BYTES}-byte limit`,
      );
    }
    const rawBody = Buffer.from(JSON.stringify(event), "utf8");
    this.deliver(event, rawBody);
  }
}

function assertAgentEventIdentity(eventId: string, sequence: number): void {
  if (sequence < 0 || sequence > MAX_AGENT_EVENT_SEQUENCE) {
    throw new RangeError(
      `Agent event sequence ${sequence} is outside the 0..${MAX_AGENT_EVENT_SEQUENCE} range`,
    );
  }
  if (eventId.length > MAX_AGENT_EVENT_ID_LENGTH) {
    throw new RangeError(
      `Generated Agent event id exceeds the ${MAX_AGENT_EVENT_ID_LENGTH}-character limit`,
    );
  }
}

function validateEventPayload(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
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
  return json as Record<string, JsonValue>;
}
