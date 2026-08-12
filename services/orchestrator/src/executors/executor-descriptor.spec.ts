import {
  buildExecutorDescriptor,
  EXECUTOR_DESCRIPTOR_SCHEMA_VERSION,
  parseExecutorDescriptor,
  readExecutorDescriptor,
  type ExecutorDescriptorV1,
} from "./executor-descriptor";
import type { AgentTransportConfiguration } from "../agent-adapters/agent-transport-config.service";

const httpConfiguration: AgentTransportConfiguration = {
  kind: "http",
  submitUrl: "https://security-agent.internal/v1/runs",
  outboundAuthentication: { type: "bearer", token: "bearer-secret" },
  callbackAuthentication: { keyId: "security-agent-v1", secret: "callback-secret" },
  requestTimeoutMs: 5000,
  maxResponseBytes: 1024,
  delegationModes: ["opaque", "observed"],
};

const kafkaConfiguration: AgentTransportConfiguration = {
  kind: "kafka",
  delegationModes: ["opaque", "observed"],
};

const live = (agent: string): AgentTransportConfiguration =>
  agent === "remote-security-reviewer" ? httpConfiguration : kafkaConfiguration;

const expectRejected = (fail: () => unknown, code: string): void => {
  try {
    fail();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

describe("buildExecutorDescriptor", () => {
  it("freezes the HTTP routing profile and never any secret value", () => {
    const descriptor = buildExecutorDescriptor(
      "remote-security-reviewer",
      httpConfiguration,
    );

    expect(descriptor).toEqual({
      schemaVersion: "1",
      executorId: "agent:remote-security-reviewer",
      agent: "remote-security-reviewer",
      kind: "http",
      configHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      capabilities: { cancel: false },
      httpProfile: {
        submitUrl: "https://security-agent.internal/v1/runs",
        requestTimeoutMs: 5000,
        maxResponseBytes: 1024,
      },
    });
    // Credential values never enter the descriptor, so every render is a
    // safe redacted view.
    expect(JSON.stringify(descriptor)).not.toContain("bearer-secret");
    expect(JSON.stringify(descriptor)).not.toContain("callback-secret");
  });

  it("freezes the Kafka executor without a profile", () => {
    const descriptor = buildExecutorDescriptor("code-reviewer", kafkaConfiguration);

    expect(descriptor).toMatchObject({
      schemaVersion: "1",
      executorId: "agent:code-reviewer",
      agent: "code-reviewer",
      kind: "kafka",
      capabilities: { cancel: false },
    });
    expect(descriptor.httpProfile).toBeUndefined();
  });

  it("hashes the non-secret profile canonically and stably", () => {
    const first = buildExecutorDescriptor("code-reviewer", kafkaConfiguration);
    const second = buildExecutorDescriptor("code-reviewer", kafkaConfiguration);
    expect(first.configHash).toBe(second.configHash);
    expect(first.configHash).not.toBe(
      buildExecutorDescriptor("remote-security-reviewer", httpConfiguration)
        .configHash,
    );
    expect(first.configHash).not.toBe(
      buildExecutorDescriptor("remote-security-reviewer", {
        ...httpConfiguration,
        requestTimeoutMs: 6000,
      }).configHash,
    );
  });

  it("rejects an empty or oversized agent", () => {
    expectRejected(
      () => buildExecutorDescriptor("", kafkaConfiguration),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () => buildExecutorDescriptor("a".repeat(256), kafkaConfiguration),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
  });
});

describe("parseExecutorDescriptor", () => {
  const valid = buildExecutorDescriptor("remote-security-reviewer", httpConfiguration);

  it("round-trips a built descriptor", () => {
    expect(parseExecutorDescriptor(valid)).toEqual(valid);
  });

  it("rejects unknown schema versions, kinds, fields, and capability keys", () => {
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, schemaVersion: "2" }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, kind: "ssh" }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, sneakyField: "x" }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () =>
        parseExecutorDescriptor({
          ...valid,
          capabilities: { cancel: false, actionProposal: true },
        }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
  });

  it("rejects out-of-bounds strings and malformed hashes", () => {
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, agent: "a".repeat(256) }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () =>
        parseExecutorDescriptor({
          ...valid,
          httpProfile: { ...valid.httpProfile!, submitUrl: undefined },
        }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, configHash: "short" }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, configHash: "A".repeat(64) }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
  });

  it("rejects HTTP descriptors without a profile and Kafka descriptors with one", () => {
    const { httpProfile, ...withoutProfile } = valid;
    expectRejected(
      () => parseExecutorDescriptor(withoutProfile),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () =>
        parseExecutorDescriptor({
          ...buildExecutorDescriptor("code-reviewer", kafkaConfiguration),
          httpProfile: valid.httpProfile,
        }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
  });

  it("rejects profiles with credentials in the URL or non-positive integers", () => {
    expectRejected(
      () =>
        parseExecutorDescriptor({
          ...valid,
          httpProfile: {
            ...valid.httpProfile!,
            submitUrl: "https://user:pass@host.example/v1",
          },
        }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () =>
        parseExecutorDescriptor({
          ...valid,
          httpProfile: { ...valid.httpProfile!, requestTimeoutMs: 0 },
        }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
    expectRejected(
      () => parseExecutorDescriptor({ ...valid, httpProfile: "not-an-object" }),
      "EXECUTOR_DESCRIPTOR_INVALID",
    );
  });

  it("is JSON-clean: no functions, dates, or undefined fields survive", () => {
    const parsed = parseExecutorDescriptor(JSON.parse(JSON.stringify(valid)));
    expect(parsed).toEqual(valid);
    expect(parsed.schemaVersion).toBe(EXECUTOR_DESCRIPTOR_SCHEMA_VERSION);
  });
});

describe("readExecutorDescriptor (compatibility reader)", () => {
  it("returns the frozen descriptor pinned, even when live configuration rotated", () => {
    const frozen = buildExecutorDescriptor(
      "remote-security-reviewer",
      httpConfiguration,
    );
    // Live config now routes the agent to Kafka; the pinned descriptor wins.
    const descriptor = readExecutorDescriptor(frozen, () => kafkaConfiguration);

    expect(descriptor.kind).toBe("http");
    expect(descriptor.httpProfile?.submitUrl).toBe(
      "https://security-agent.internal/v1/runs",
    );
  });

  it("maps a legacy { agent } snapshot through live configuration (HTTP and Kafka default)", () => {
    const httpCompat = readExecutorDescriptor(
      { agent: "remote-security-reviewer" },
      live,
    );
    expect(httpCompat).toMatchObject({
      schemaVersion: "1",
      kind: "http",
      executorId: "agent:remote-security-reviewer",
    });
    expect(httpCompat.httpProfile?.submitUrl).toBe(
      "https://security-agent.internal/v1/runs",
    );

    const kafkaCompat = readExecutorDescriptor({ agent: "code-reviewer" }, live);
    expect(kafkaCompat).toMatchObject({ schemaVersion: "1", kind: "kafka" });
    expect(kafkaCompat.httpProfile).toBeUndefined();
  });

  it("does not rewrite the legacy row and accepts extra legacy fields", () => {
    const descriptor = readExecutorDescriptor(
      { agent: "code-reviewer", someOldField: 1 },
      live,
    );
    expect(descriptor.kind).toBe("kafka");
  });

  it("rejects unknown schema versions and unreadable snapshots", () => {
    expectRejected(
      () => readExecutorDescriptor({ schemaVersion: "2", agent: "x" }, live),
      "EXECUTOR_SNAPSHOT_INVALID",
    );
    expectRejected(() => readExecutorDescriptor({}, live), "EXECUTOR_SNAPSHOT_INVALID");
    expectRejected(() => readExecutorDescriptor(null, live), "EXECUTOR_SNAPSHOT_INVALID");
    expectRejected(() => readExecutorDescriptor("agent", live), "EXECUTOR_SNAPSHOT_INVALID");
    expectRejected(
      () => readExecutorDescriptor({ agent: "a".repeat(256) }, live),
      "EXECUTOR_SNAPSHOT_INVALID",
    );
  });

  it("classifies every rejection as non-retryable configuration failure", () => {
    const failures: Array<() => ExecutorDescriptorV1> = [
      () => parseExecutorDescriptor({ schemaVersion: "1" }),
      () => readExecutorDescriptor({}, live),
      () => buildExecutorDescriptor("", kafkaConfiguration),
    ];
    for (const fail of failures) {
      try {
        fail();
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ retryable: false });
        expect(["EXECUTOR_DESCRIPTOR_INVALID", "EXECUTOR_SNAPSHOT_INVALID"]).toContain(
          (error as { code: string }).code,
        );
      }
    }
  });
});
