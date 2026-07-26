import { authenticateBearer, constantTimeEqual } from "../src/auth/bearer-auth";
import { validateCallbackUrl } from "../src/auth/callback-policy";

describe("bearer authentication", () => {
  it.each([
    "Bearer worker-token",
    "bearer worker-token",
    "BEARER worker-token",
  ])("accepts valid case-insensitive scheme %s", (authorization) => {
    expect(authenticateBearer(authorization, "worker-token")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "Basic worker-token",
    "Bearer",
    "Bearer ",
    "Bearer wrong-token",
  ])("rejects malformed or invalid authorization %s", (authorization) => {
    expect(authenticateBearer(authorization, "worker-token")).toBe(false);
  });

  it("uses a constant-time helper for equal-length token bytes", () => {
    expect(constantTimeEqual(Buffer.from("same"), Buffer.from("same"))).toBe(
      true,
    );
    expect(constantTimeEqual(Buffer.from("same"), Buffer.from("diff"))).toBe(
      false,
    );
    expect(constantTimeEqual(Buffer.from("short"), Buffer.from("longer"))).toBe(
      false,
    );
  });
});

describe("callback target policy", () => {
  const options = {
    allowedOrigins: [
      "https://orchestrator.example",
      "https://orchestrator.example:8443",
    ],
    allowInsecureHttp: false,
  };

  it("allows a path on an exact normalized origin", () => {
    expect(
      validateCallbackUrl(
        "https://orchestrator.example/internal/agent-callbacks/http/echo",
        options,
      ).origin,
    ).toBe("https://orchestrator.example");
  });

  it.each([
    "https://orchestrator.example.attacker.test/callback",
    "https://user:pass@orchestrator.example/callback",
    "https://orchestrator.example/callback?token=secret",
    "https://orchestrator.example/callback#fragment",
    "http://orchestrator.example/callback",
    "https://orchestrator.example:9443/callback",
  ])("rejects disallowed callback URL %s", (url) => {
    expect(() => validateCallbackUrl(url, options)).toThrow();
  });

  it("allows exact insecure origin only with explicit policy", () => {
    expect(
      validateCallbackUrl("http://127.0.0.1:3000/callback", {
        allowedOrigins: ["http://127.0.0.1:3000"],
        allowInsecureHttp: true,
      }).origin,
    ).toBe("http://127.0.0.1:3000");
  });
});
