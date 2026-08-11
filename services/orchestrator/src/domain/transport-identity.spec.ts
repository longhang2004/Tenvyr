import {
  MAX_SOURCE_ADAPTER_LENGTH,
  MAX_SOURCE_MESSAGE_ID_LENGTH,
  MAX_SOURCE_SCOPE_LENGTH,
  boundedKafkaScope,
  durableTransportIdentity,
} from "./transport-identity";

describe("durableTransportIdentity", () => {
  it("maps HTTP keyId/deliveryId to unchanged bounded values", () => {
    const identity = durableTransportIdentity({
      adapter: "http",
      receivedAt: "now",
      keyId: "callback-v1",
      deliveryId: "delivery-1",
    });
    expect(identity).toEqual({
      adapter: "http",
      scope: "callback-v1",
      messageId: "delivery-1",
    });
  });

  it("keeps a short Kafka topic+partition scope readable and unchanged", () => {
    const identity = durableTransportIdentity({
      adapter: "kafka",
      receivedAt: "now",
      topic: "agentweave.agent.reader.event",
      partition: 2,
      offset: "41",
    });
    expect(identity).toEqual({
      adapter: "kafka",
      scope: "agentweave.agent.reader.event:2",
      messageId: "41",
    });
  });

  it("maps a very long Kafka topic+partition to a deterministic bounded scope", () => {
    const longTopic = `agentweave.agent.${"t".repeat(260)}`;
    const rawScope = `${longTopic}:12345`;
    expect(rawScope.length).toBeGreaterThan(MAX_SOURCE_SCOPE_LENGTH);

    const first = durableTransportIdentity({
      adapter: "kafka",
      receivedAt: "now",
      topic: longTopic,
      partition: 12345,
      offset: "7",
    });
    const second = durableTransportIdentity({
      adapter: "kafka",
      receivedAt: "now",
      topic: longTopic,
      partition: 12345,
      offset: "7",
    });
    expect(first.scope).toMatch(/^kafka-sha256:[0-9a-f]{64}$/);
    expect(first.scope).toBe(second.scope);
    expect(first.scope?.length).toBeLessThanOrEqual(MAX_SOURCE_SCOPE_LENGTH);
    expect(first.messageId).toBe("7");
  });

  it("produces different scopes for the same long topic on different partitions", () => {
    const longTopic = `agentweave.agent.${"t".repeat(260)}`;
    const a = durableTransportIdentity({
      adapter: "kafka",
      receivedAt: "now",
      topic: longTopic,
      partition: 1,
      offset: "7",
    });
    const b = durableTransportIdentity({
      adapter: "kafka",
      receivedAt: "now",
      topic: longTopic,
      partition: 2,
      offset: "7",
    });
    expect(a.scope).not.toBe(b.scope);
  });

  it("returns boundedKafkaScope unchanged when it fits and hashed when it does not", () => {
    expect(boundedKafkaScope("short:0")).toBe("short:0");
    const raw = "x".repeat(300);
    const hashed = boundedKafkaScope(raw);
    expect(hashed.startsWith("kafka-sha256:")).toBe(true);
    expect(hashed).toBe(boundedKafkaScope(raw)); // deterministic
    expect(hashed).not.toBe(boundedKafkaScope(`${raw}x`)); // collision-resistant
  });

  it("returns null scope/messageId when the transport carries none", () => {
    expect(
      durableTransportIdentity({ adapter: "supervision", receivedAt: "now" }),
    ).toEqual({ adapter: "supervision", scope: null, messageId: null });
  });

  it("throws on identity values that exceed the durable bounds instead of truncating", () => {
    expect(() =>
      durableTransportIdentity({
        adapter: "http",
        receivedAt: "now",
        keyId: "k".repeat(MAX_SOURCE_SCOPE_LENGTH + 1),
      }),
    ).toThrow(/durable bound/);
    expect(() =>
      durableTransportIdentity({
        adapter: "http",
        receivedAt: "now",
        keyId: "k",
        deliveryId: "d".repeat(MAX_SOURCE_MESSAGE_ID_LENGTH + 1),
      }),
    ).toThrow(/durable bound/);
    expect(() =>
      durableTransportIdentity({
        adapter: "kafka",
        receivedAt: "now",
        topic: "t",
        partition: 0,
        offset: "o".repeat(MAX_SOURCE_MESSAGE_ID_LENGTH + 1),
      }),
    ).toThrow(/durable bound/);
    expect(() =>
      durableTransportIdentity({
        adapter: "a".repeat(MAX_SOURCE_ADAPTER_LENGTH + 1),
        receivedAt: "now",
      }),
    ).toThrow(/durable bound/);
  });

  it("always returns persisted strings within the entity column limits", () => {
    const inputs = [
      { adapter: "http", keyId: "k".repeat(255), deliveryId: "d".repeat(255) },
      {
        adapter: "kafka",
        topic: `agentweave.agent.${"t".repeat(260)}`,
        partition: 2147483647,
        offset: "999999999999",
      },
    ];
    for (const transport of inputs) {
      const identity = durableTransportIdentity(transport as never);
      expect(identity.adapter.length).toBeLessThanOrEqual(
        MAX_SOURCE_ADAPTER_LENGTH,
      );
      expect((identity.scope ?? "").length).toBeLessThanOrEqual(
        MAX_SOURCE_SCOPE_LENGTH,
      );
      expect((identity.messageId ?? "").length).toBeLessThanOrEqual(
        MAX_SOURCE_MESSAGE_ID_LENGTH,
      );
    }
  });
});
