import { AnySchemaObject } from "ajv";
import { existsSync } from "fs";
import { join, resolve } from "path";

const packagedSchemas = join(__dirname, "schema-json");
const schemaDirectory = existsSync(packagedSchemas)
  ? packagedSchemas
  : resolve(__dirname, "../../../contracts/schemas");
const schema = (name: string) =>
  require(join(schemaDirectory, name)) as AnySchemaObject;

export const agentInvocationV1Schema = schema(
  "agent-invocation.v1.schema.json",
);
export const agentResultV1Schema = schema("agent-result.v1.schema.json");
export const agentEventV1Schema = schema("agent-event.v1.schema.json");
export const httpAgentRunRequestV1Schema = schema(
  "http-agent-run-request.v1.schema.json",
);
export const httpAgentRunAcceptedV1Schema = schema(
  "http-agent-run-accepted.v1.schema.json",
);
