import { createHash } from "crypto";
import type { AgentTransportMetadata } from "../agent-adapters/agent-adapter.types";

/**
 * Durable transport evidence bounds, matching the bounded varchar columns used
 * by both the AgentEvent and ResultInbox tables (and their conflict tables).
 * The invariant: transport metadata accepted by the control plane always fits
 * these columns before persistence, so a varchar overflow can never be
 * misclassified as a retryable infrastructure failure.
 */
export const MAX_SOURCE_ADAPTER_LENGTH = 50;
export const MAX_SOURCE_SCOPE_LENGTH = 255;
export const MAX_SOURCE_MESSAGE_ID_LENGTH = 255;

export type DurableTransportIdentity = {
  adapter: string;
  scope: string | null;
  messageId: string | null;
};

/**
 * Deterministic bounded representation of a Kafka durable scope. The raw
 * `${topic}:${partition}` form is persisted unchanged when it fits; longer
 * values are hashed so the scope is always <= 255 characters, deterministic,
 * collision-resistant, and never a lossy truncation (truncation could make
 * distinct deliveries collide on the transport dedup index).
 */
export function boundedKafkaScope(rawScope: string): string {
  if (rawScope.length <= MAX_SOURCE_SCOPE_LENGTH) return rawScope;
  return `kafka-sha256:${createHash("sha256").update(rawScope).digest("hex")}`;
}

/**
 * The single source of truth for the durable transport identity of an
 * inbound delivery, shared by AgentEventService and ResultInboxService so
 * both tables encode the same bounded storage constraints.
 *
 * - adapter: application-internal constant; asserted defensively <= 50.
 * - scope: HTTP = keyId (bounded to 255 by transport configuration
 *   validation); Kafka = boundedKafkaScope(`${topic}:${partition}`).
 * - messageId: HTTP = deliveryId (bounded to 255 by the HTTP adapter trust
 *   boundary); Kafka = offset (defensively asserted; KafkaJS offsets are
 *   numeric strings).
 *
 * An identity that violates the durable bounds throws a permanent
 * configuration/programming error: it is never silently truncated.
 */
export function durableTransportIdentity(
  transport: AgentTransportMetadata,
): DurableTransportIdentity {
  const adapter = transport.adapter;
  if (adapter.length > MAX_SOURCE_ADAPTER_LENGTH) {
    throw new Error(
      `Transport adapter "${adapter}" exceeds the ${MAX_SOURCE_ADAPTER_LENGTH}-character durable bound`,
    );
  }
  if (transport.adapter === "kafka") {
    // Offsets are per-partition: the scope must include the partition so the
    // transport dedup index cannot collide across partitions. An undefined
    // partition defaults to 0 (parity with the pre-consolidation derivation).
    const scope =
      transport.topic !== undefined
        ? boundedKafkaScope(`${transport.topic}:${transport.partition ?? 0}`)
        : null;
    const messageId = transport.offset ?? null;
    if (messageId !== null && messageId.length > MAX_SOURCE_MESSAGE_ID_LENGTH) {
      throw new Error(
        `Kafka offset exceeds the ${MAX_SOURCE_MESSAGE_ID_LENGTH}-character durable bound`,
      );
    }
    return { adapter, scope, messageId };
  }
  const scope = transport.keyId ?? null;
  if (scope !== null && scope.length > MAX_SOURCE_SCOPE_LENGTH) {
    throw new Error(
      `Transport scope exceeds the ${MAX_SOURCE_SCOPE_LENGTH}-character durable bound`,
    );
  }
  const messageId = transport.deliveryId ?? null;
  if (messageId !== null && messageId.length > MAX_SOURCE_MESSAGE_ID_LENGTH) {
    throw new Error(
      `Transport message id exceeds the ${MAX_SOURCE_MESSAGE_ID_LENGTH}-character durable bound`,
    );
  }
  return { adapter, scope, messageId };
}
