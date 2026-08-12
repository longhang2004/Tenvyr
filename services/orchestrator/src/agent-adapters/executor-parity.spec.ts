import { parseAgentInvocation, type AgentInvocationV1 } from "@tenvyr/contracts";
import { parseHttpAgentRunRequest } from "@tenvyr/contracts";
import { canonicalJson } from "../domain/canonical-json";

/**
 * M3-S5: cross-executor input parity.
 *
 * One AgentInvocationV1 must reach every executor as byte-identical canonical
 * JSON: the Kafka topic payload (kafka-agent.adapter serializes the parsed
 * invocation), the HTTP run request's invocation (http-agent.adapter embeds
 * the parsed invocation), and the local executor host's bounded stdin channel
 * (the host writes the parsed run-request invocation). Providers and runtimes
 * never change the canonical invocation — only the transport framing differs.
 */
describe("cross-executor invocation parity (M3-S5)", () => {
  const invocation: AgentInvocationV1 = {
    schemaVersion: "1",
    invocationId: "step-parity-1:1",
    executionId: "execution-parity-1",
    stepExecutionId: "step-parity-1",
    stepId: "parity-step",
    target: { agent: "parity-agent" },
    input: { nested: { values: [1, 2, 3], flag: true } },
    context: {
      schemaVersion: "1",
      stateProjection: { version: 0, values: { key: "value" } },
      artifacts: [],
    },
    attempt: 2,
    createdAt: "2026-08-11T00:00:00.000Z",
    deadlineAt: "2026-08-11T01:00:00.000Z",
    trace: {
      traceId: "execution-parity-1",
      correlationId: "step-parity-1:1",
    },
  };

  const kafkaPayload = (): string =>
    // kafka-agent.adapter: value = JSON.stringify(parseAgentInvocation(invocation))
    JSON.stringify(parseAgentInvocation(invocation));

  const httpRunRequestInvocation = (): unknown =>
    // http-agent.adapter: parseHttpAgentRunRequest({ invocation: payload, ... })
    parseHttpAgentRunRequest({
      schemaVersion: "1",
      invocation: parseAgentInvocation(invocation),
      resultDelivery: {
        mode: "callback",
        callbackUrl: "http://127.0.0.1:1/internal/agent-callbacks/http/parity-agent",
        authentication: { scheme: "hmac-sha256", keyId: "parity-v1" },
      },
    }).invocation;

  it("serializes the canonical invocation identically on the Kafka and HTTP executor paths", () => {
    const kafka = canonicalJson(JSON.parse(kafkaPayload()));
    const http = canonicalJson(httpRunRequestInvocation());

    expect(http).toBe(kafka);
  });

  it("the local executor host receives the same canonical invocation on its stdin channel", () => {
    // The host writes JSON.stringify(parsedRunRequest.invocation) to the
    // child's bounded stdin; the child's parse must recover the identical
    // canonical invocation.
    const hostStdinBytes = JSON.stringify(
      parseHttpAgentRunRequest({
        schemaVersion: "1",
        invocation: parseAgentInvocation(invocation),
        resultDelivery: {
          mode: "callback",
          callbackUrl: "http://127.0.0.1:1/internal/agent-callbacks/http/parity-agent",
          authentication: { scheme: "hmac-sha256", keyId: "parity-v1" },
        },
      }).invocation,
    );
    const recovered = parseAgentInvocation(JSON.parse(hostStdinBytes));

    expect(canonicalJson(recovered)).toBe(canonicalJson(parseAgentInvocation(invocation)));
  });

  it("never lets transport framing change the invocation identity fields", () => {
    const http = httpRunRequestInvocation() as AgentInvocationV1;
    expect(http.invocationId).toBe(invocation.invocationId);
    expect(http.executionId).toBe(invocation.executionId);
    expect(http.stepExecutionId).toBe(invocation.stepExecutionId);
    expect(http.target).toEqual(invocation.target);
    expect(http.attempt).toBe(invocation.attempt);
  });
});
