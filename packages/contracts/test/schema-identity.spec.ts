import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonSchema = {
  $id: string;
  properties: Record<string, unknown>;
};

const schemaDirectory = resolve(__dirname, "../../../contracts/schemas");
const schema = (name: string) =>
  JSON.parse(
    readFileSync(resolve(schemaDirectory, name), "utf8"),
  ) as JsonSchema;

const schemas = {
  "agent-invocation.v1.schema.json": schema("agent-invocation.v1.schema.json"),
  "agent-result.v1.schema.json": schema("agent-result.v1.schema.json"),
  "agent-event.v1.schema.json": schema("agent-event.v1.schema.json"),
  "http-agent-run-request.v1.schema.json": schema(
    "http-agent-run-request.v1.schema.json",
  ),
  "http-agent-run-accepted.v1.schema.json": schema(
    "http-agent-run-accepted.v1.schema.json",
  ),
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
};

const semanticHash = (value: JsonSchema): string => {
  const normalized = structuredClone(value) as Record<string, unknown>;
  normalized.$id = "<schema-id>";

  const normalizeExternalRef = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(normalizeExternalRef);
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }

    const object = node as Record<string, unknown>;
    if (object.$ref === "urn:tenvyr:schema:agent-invocation:v1") {
      object.$ref = "<agent-invocation-ref>";
    }
    Object.values(object).forEach(normalizeExternalRef);
  };

  normalizeExternalRef(normalized);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(normalized)))
    .digest("hex");
};

describe("schema identity", () => {
  it("uses the exact Tenvyr URNs without product-domain IDs", () => {
    expect(
      Object.fromEntries(
        Object.entries(schemas).map(([name, value]) => [name, value.$id]),
      ),
    ).toEqual({
      "agent-invocation.v1.schema.json":
        "urn:tenvyr:schema:agent-invocation:v1",
      "agent-result.v1.schema.json": "urn:tenvyr:schema:agent-result:v1",
      "agent-event.v1.schema.json": "urn:tenvyr:schema:agent-event:v1",
      "http-agent-run-request.v1.schema.json":
        "urn:tenvyr:schema:http-agent-run-request:v1",
      "http-agent-run-accepted.v1.schema.json":
        "urn:tenvyr:schema:http-agent-run-accepted:v1",
    });

    const serialized = JSON.stringify(schemas);
    expect(serialized).not.toContain("agentweave.dev");
    expect(serialized).not.toContain("tenvyr.dev");
  });

  it("keeps every non-identity schema semantic exact", () => {
    expect(
      Object.fromEntries(
        Object.entries(schemas).map(([name, value]) => [
          name,
          semanticHash(value),
        ]),
      ),
    ).toEqual({
      "agent-invocation.v1.schema.json":
        "53600644d4a7cae3bec98ae842e7d61e6d11eca168610626a171ff00603ea758",
      "agent-result.v1.schema.json":
        "aef71fbea9654b28abb501f4fe78282b26fc84516c930c3b7e65dcbe5a6c5263",
      "agent-event.v1.schema.json":
        "83a33fe7b389139482eee47ae94826c0e441ee679c0e738223b6e32b3d4ab684",
      "http-agent-run-request.v1.schema.json":
        "7fd10772905009ecf6b480b35d6f4af251996cdb39b54044d3aa419dcd065041",
      "http-agent-run-accepted.v1.schema.json":
        "8665c2369db9e812c8164dad3b51b38ba2d64689dea3739d82f1ded54d093d5d",
    });

    expect(
      schemas["http-agent-run-request.v1.schema.json"].properties.invocation,
    ).toEqual({ $ref: "urn:tenvyr:schema:agent-invocation:v1" });
  });
});
