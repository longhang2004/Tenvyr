import { ContractValidationError, type AgentInvocationV1, type AgentResultV1 } from '@agentweave/contracts';
import { AgentTransportConfigService, parseAgentTransportConfiguration } from './agent-transport-config.service';
import { createHttpCallbackSignature } from './http-callback-auth';
import { HttpAgentAdapter } from './http-agent.adapter';

const invocation: AgentInvocationV1 = {
  schemaVersion: '1',
  invocationId: 'step-execution-1:1',
  executionId: 'execution-1',
  stepExecutionId: 'step-execution-1',
  stepId: 'security-review',
  target: { agent: 'remote-security-reviewer' },
  input: { code: 'TOP_SECRET_INPUT' },
  attempt: 1,
  createdAt: '2026-07-26T00:00:00.000Z',
  trace: {
    traceId: 'execution-1',
    correlationId: 'step-execution-1:1',
  },
};

const result: AgentResultV1 = {
  schemaVersion: '1',
  invocationId: invocation.invocationId,
  executionId: invocation.executionId,
  stepExecutionId: invocation.stepExecutionId,
  status: 'succeeded',
  output: { score: 100 },
  completedAt: '2026-07-26T00:00:02.000Z',
};

const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  AGENT_TRANSPORT_CONFIG: JSON.stringify({
    'remote-security-reviewer': {
      kind: 'http',
      submitUrl: 'https://security-agent.internal/v1/runs',
      outboundAuthentication: {
        type: 'bearer',
        tokenEnv: 'SECURITY_AGENT_TOKEN',
      },
      callbackAuthentication: {
        keyId: 'security-agent-v1',
        secretEnv: 'SECURITY_AGENT_CALLBACK_SECRET',
      },
      requestTimeoutMs: 100,
      maxResponseBytes: 1024,
    },
  }),
  HTTP_AGENT_CALLBACK_BASE_URL: 'https://orchestrator.example',
  SECURITY_AGENT_TOKEN: 'bearer-secret',
  SECURITY_AGENT_CALLBACK_SECRET: 'callback-secret',
  ...overrides,
});

const acceptedResponse = (overrides: Record<string, unknown> = {}, status = 202) =>
  new Response(
    JSON.stringify({
      schemaVersion: '1',
      invocationId: invocation.invocationId,
      runId: 'remote-run-123',
      status: 'accepted',
      acceptedAt: '2026-07-26T00:00:01.000Z',
      ...overrides,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );

describe('HttpAgentAdapter', () => {
  let adapter: HttpAgentAdapter;
  let handler: jest.Mock;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    const config = new AgentTransportConfigService(parseAgentTransportConfiguration(environment()));
    adapter = new HttpAgentAdapter(config);
    handler = jest.fn().mockResolvedValue(undefined);
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(acceptedResponse());
  });

  afterEach(() => {
    fetchMock.mockRestore();
    jest.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('exposes a stable kind and starts/stops idempotently', async () => {
      expect(adapter.kind).toBe('http');
      await adapter.start(handler);
      await adapter.start(handler);
      await adapter.stop();
      await adapter.stop();
      await expect(adapter.invoke(invocation)).rejects.toMatchObject({ code: 'ADAPTER_NOT_STARTED' });
    });

    it('rejects a different handler while already started', async () => {
      await adapter.start(handler);

      await expect(adapter.start(jest.fn())).rejects.toMatchObject({ code: 'ADAPTER_START_FAILED' });
    });
  });

  describe('outbound', () => {
    beforeEach(async () => {
      await adapter.start(handler);
    });

    it('submits the canonical callback request with authentication and idempotency headers', async () => {
      await adapter.invoke(invocation);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://security-agent.internal/v1/runs');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer bearer-secret',
        'Idempotency-Key': invocation.invocationId,
      });
      expect(JSON.parse(init.body as string)).toEqual({
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
      });
      expect(init.body).not.toContain('callback-secret');
    });

    it('omits Authorization for explicit none authentication', async () => {
      const config = new AgentTransportConfigService(
        parseAgentTransportConfiguration(
          environment({
            AGENT_TRANSPORT_CONFIG: JSON.stringify({
              'remote-security-reviewer': {
                kind: 'http',
                submitUrl: 'https://security-agent.internal/v1/runs',
                outboundAuthentication: { type: 'none' },
                callbackAuthentication: {
                  keyId: 'security-agent-v1',
                  secretEnv: 'SECURITY_AGENT_CALLBACK_SECRET',
                },
                requestTimeoutMs: 100,
                maxResponseBytes: 1024,
              },
            }),
          }),
        ),
      );
      const noAuthAdapter = new HttpAgentAdapter(config);
      await noAuthAdapter.start(handler);

      await noAuthAdapter.invoke(invocation);

      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Authorization');
    });

    it('returns a correlated receipt with the remote run ID', async () => {
      const receipt = await adapter.invoke(invocation);

      expect(receipt).toMatchObject({
        adapter: 'http',
        invocationId: invocation.invocationId,
        dispatchId: 'remote-run-123',
      });
      expect(Date.parse(receipt.dispatchedAt)).not.toBeNaN();
    });

    it('rejects invalid invocation before the request', async () => {
      await expect(adapter.invoke({ ...invocation, attempt: 0 })).rejects.toBeInstanceOf(ContractValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a response invocation mismatch', async () => {
      fetchMock.mockResolvedValue(acceptedResponse({ invocationId: 'different:1' }));

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'HTTP_INVOCATION_MISMATCH',
        retryable: false,
      });
    });

    it.each([
      [200, false],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ])('maps HTTP %i rejection with retryable=%s', async (status, retryable) => {
      fetchMock.mockResolvedValue(acceptedResponse({}, status));

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'HTTP_REJECTED',
        httpStatus: status,
        retryable,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps connection failure as retryable without retrying', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED bearer-secret'));

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'HTTP_CONNECTION_FAILED',
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts timed-out requests without retrying', async () => {
      fetchMock.mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'HTTP_REQUEST_TIMEOUT',
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects oversized responses', async () => {
      fetchMock.mockResolvedValue(
        new Response('x'.repeat(1025), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'HTTP_RESPONSE_TOO_LARGE',
        retryable: false,
      });
    });

    it.each([
      ['invalid JSON', new Response('{no-json', { status: 202, headers: { 'Content-Type': 'application/json' } })],
      [
        'invalid accepted response',
        acceptedResponse({
          runId: '',
        }),
      ],
      ['invalid content type', new Response('{}', { status: 202, headers: { 'Content-Type': 'text/plain' } })],
    ])('rejects %s', async (_case, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'HTTP_INVALID_RESPONSE',
        retryable: false,
      });
    });

    it('does not log input, bearer token, callback secret, or response body', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation();
      const error = jest.spyOn(console, 'error').mockImplementation();
      fetchMock.mockResolvedValue(
        new Response('TOP_SECRET_RESPONSE', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      await expect(adapter.invoke(invocation)).rejects.toBeDefined();

      const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain('TOP_SECRET_INPUT');
      expect(logged).not.toContain('bearer-secret');
      expect(logged).not.toContain('callback-secret');
      expect(logged).not.toContain('TOP_SECRET_RESPONSE');
    });
  });

  describe('callback delivery', () => {
    const timestamp = '1785024000';
    const rawBody = Buffer.from(JSON.stringify(result));
    const callback = (overrides: Record<string, unknown> = {}) => ({
      agent: 'remote-security-reviewer',
      keyId: 'security-agent-v1',
      timestamp,
      deliveryId: 'delivery-1',
      signature: createHttpCallbackSignature('callback-secret', timestamp, 'delivery-1', rawBody),
      rawBody,
      remoteAddress: '127.0.0.1',
      nowMs: Number(timestamp) * 1000,
      ...overrides,
    });

    beforeEach(async () => {
      await adapter.start(handler);
    });

    it('authenticates, validates, and delivers a canonical result with HTTP metadata', async () => {
      await expect(adapter.handleCallback(callback())).resolves.toBe('processed');

      expect(handler).toHaveBeenCalledWith({
        result,
        transport: expect.objectContaining({
          adapter: 'http',
          deliveryId: 'delivery-1',
          keyId: 'security-agent-v1',
          remoteAddress: '127.0.0.1',
        }),
      });
    });

    it('returns duplicate without calling the handler twice', async () => {
      await adapter.handleCallback(callback());
      await expect(adapter.handleCallback(callback())).resolves.toBe('duplicate');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['unknown agent', { agent: 'unknown' }],
      ['unknown key ID', { keyId: 'unknown' }],
      ['invalid signature', { signature: `v1=${'0'.repeat(64)}` }],
    ])('rejects %s before result delivery', async (_case, overrides) => {
      await expect(adapter.handleCallback(callback(overrides))).rejects.toMatchObject({
        code: 'CALLBACK_UNAUTHORIZED',
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects invalid JSON after authentication', async () => {
      const invalidBody = Buffer.from('{not-json');
      const request = callback({
        rawBody: invalidBody,
        signature: createHttpCallbackSignature('callback-secret', timestamp, 'delivery-1', invalidBody),
      });

      await expect(adapter.handleCallback(request)).rejects.toMatchObject({ code: 'CALLBACK_INVALID' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects invalid result contracts', async () => {
      const invalidBody = Buffer.from(JSON.stringify({ ...result, stepExecutionId: '' }));
      const request = callback({
        rawBody: invalidBody,
        signature: createHttpCallbackSignature('callback-secret', timestamp, 'delivery-1', invalidBody),
      });

      await expect(adapter.handleCallback(request)).rejects.toBeInstanceOf(ContractValidationError);
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns unavailable when no result handler is registered', async () => {
      await adapter.stop();

      await expect(adapter.handleCallback(callback())).rejects.toMatchObject({
        code: 'CALLBACK_HANDLER_UNAVAILABLE',
      });
    });

    it('allows retry after handler failure', async () => {
      handler.mockRejectedValueOnce(new Error('temporary result failure')).mockResolvedValueOnce(undefined);

      await expect(adapter.handleCallback(callback())).rejects.toMatchObject({
        code: 'RESULT_HANDLER_FAILED',
      });
      await expect(adapter.handleCallback(callback())).resolves.toBe('processed');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not log the full result body or raw signature', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation();
      const error = jest.spyOn(console, 'error').mockImplementation();
      const request = callback();

      await adapter.handleCallback(request);

      const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain(JSON.stringify(result));
      expect(logged).not.toContain(request.signature);
    });
  });
});
