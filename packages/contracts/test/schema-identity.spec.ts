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
        "9362353567e8e867e514955f326290cb83ea08a6d7176b6474db88a5f58ad0ad",
      "agent-result.v1.schema.json":
        "a3c46c4310d9305af2136fe8075ffd2f3fc6e36754c0e3c8323fe6c5786dbc39",
      "agent-event.v1.schema.json":
        "c6692a9419220018886915e54eddbceff7f954370675fa18366ef02c844fa0ee",
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
