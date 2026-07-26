import { AnySchemaObject } from 'ajv';

export const agentInvocationV1Schema =
  require('../../../contracts/schemas/agent-invocation.v1.schema.json') as AnySchemaObject;
export const agentResultV1Schema = require('../../../contracts/schemas/agent-result.v1.schema.json') as AnySchemaObject;
export const agentEventV1Schema = require('../../../contracts/schemas/agent-event.v1.schema.json') as AnySchemaObject;
export const httpAgentRunRequestV1Schema =
  require('../../../contracts/schemas/http-agent-run-request.v1.schema.json') as AnySchemaObject;
export const httpAgentRunAcceptedV1Schema =
  require('../../../contracts/schemas/http-agent-run-accepted.v1.schema.json') as AnySchemaObject;
