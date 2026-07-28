import { ContractValidationError, parseHttpAgentRunAccepted, parseHttpAgentRunRequest } from '../src';

const invocation = {
  schemaVersion: '1',
  invocationId: 'step-execution-1:1',
  executionId: 'execution-1',
  stepExecutionId: 'step-execution-1',
  stepId: 'review',
  target: { agent: 'remote-security-reviewer' },
  input: { code: 'const safe = true;' },
  attempt: 1,
  createdAt: '2026-07-26T00:00:00.000Z',
  trace: {
    traceId: 'execution-1',
    correlationId: 'step-execution-1:1',
  },
};

const request = {
  schemaVersion: '1',
  invocation,
  resultDelivery: {
    mode: 'callback',
    callbackUrl: 'https://orchestrator.example/internal/agent-callbacks/http/remote-security-reviewer',
    authentication: {
      scheme: 'hmac-sha256',
      keyId: 'security-agent-v1',
    },
  },
};

const accepted = {
  schemaVersion: '1',
  invocationId: invocation.invocationId,
  runId: 'remote-run-123',
  status: 'accepted',
  acceptedAt: '2026-07-26T00:00:01.000Z',
};

describe('HTTP agent transport contracts', () => {
  it('parses valid run requests and accepted responses', () => {
    expect(parseHttpAgentRunRequest(request)).toEqual(request);
    expect(parseHttpAgentRunAccepted(accepted)).toEqual(accepted);
  });

  it.each([
    ['missing callback URL', { callbackUrl: undefined }],
    ['invalid callback URL', { callbackUrl: 'not a URL' }],
    ['unsupported delivery mode', { mode: 'poll' }],
    ['callback secret in payload', { callbackSecret: 'must-not-travel' }],
  ])('rejects a request with %s', (_case, deliveryChanges) => {
    const resultDelivery = { ...request.resultDelivery, ...deliveryChanges };
    if ('callbackUrl' in deliveryChanges && deliveryChanges.callbackUrl === undefined)
      delete resultDelivery.callbackUrl;

    expect(() => parseHttpAgentRunRequest({ ...request, resultDelivery })).toThrow(ContractValidationError);
  });

  it('validates the nested invocation contract', () => {
    expect(() =>
      parseHttpAgentRunRequest({
        ...request,
        invocation: { ...invocation, attempt: 0 },
      }),
    ).toThrow(ContractValidationError);
  });

  it.each([
    ['missing run ID', { runId: undefined }],
    ['invalid accepted timestamp', { acceptedAt: 'now' }],
    ['unknown top-level field', { unexpected: true }],
  ])('rejects an accepted response with %s', (_case, changes) => {
    const value = { ...accepted, ...changes };
    if ('runId' in changes && changes.runId === undefined) delete value.runId;

    expect(() => parseHttpAgentRunAccepted(value)).toThrow(ContractValidationError);
  });
});
