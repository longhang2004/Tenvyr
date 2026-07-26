import { AgentTransportConfigService, parseAgentTransportConfiguration } from './agent-transport-config.service';

const httpConfiguration = {
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
    requestTimeoutMs: 10_000,
    maxResponseBytes: 65_536,
  },
};

const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  AGENT_TRANSPORT_CONFIG: JSON.stringify(httpConfiguration),
  HTTP_AGENT_CALLBACK_BASE_URL: 'https://orchestrator.example',
  SECURITY_AGENT_TOKEN: 'bearer-secret',
  SECURITY_AGENT_CALLBACK_SECRET: 'callback-secret',
  ...overrides,
});

describe('AgentTransportConfigService', () => {
  it('defaults existing and unknown agents to Kafka', () => {
    const config = parseAgentTransportConfiguration({});

    expect(config.agents.get('code-reviewer')).toBeUndefined();
    expect(config.agents.get('observability')).toBeUndefined();
    expect(new AgentTransportConfigService(config).forAgent('unknown')).toEqual({ kind: 'kafka' });
  });

  it('accepts an explicit empty transport map without HTTP callback configuration', () => {
    expect(() => parseAgentTransportConfiguration({ AGENT_TRANSPORT_CONFIG: '{}' })).not.toThrow();
  });

  it('resolves an exact HTTP agent and its trusted callback URL', () => {
    const service = new AgentTransportConfigService(parseAgentTransportConfiguration(environment()));

    expect(service.forAgent('remote-security-reviewer')).toMatchObject({
      kind: 'http',
      submitUrl: 'https://security-agent.internal/v1/runs',
      requestTimeoutMs: 10_000,
      maxResponseBytes: 65_536,
    });
    expect(service.callbackUrlFor('remote-security-reviewer')).toBe(
      'https://orchestrator.example/internal/agent-callbacks/http/remote-security-reviewer',
    );
  });

  it.each([
    ['missing bearer token', { SECURITY_AGENT_TOKEN: undefined }],
    ['missing callback secret', { SECURITY_AGENT_CALLBACK_SECRET: undefined }],
    [
      'invalid submit URL',
      {
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            submitUrl: 'not-a-url',
          },
        }),
      },
    ],
    [
      'embedded URL credentials',
      {
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            submitUrl: 'https://user:password@security-agent.internal/v1/runs',
          },
        }),
      },
    ],
    [
      'unsupported protocol',
      {
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            submitUrl: 'ftp://security-agent.internal/v1/runs',
          },
        }),
      },
    ],
    [
      'insecure HTTP without explicit override',
      {
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            submitUrl: 'http://127.0.0.1:8080/v1/runs',
          },
        }),
      },
    ],
    [
      'invalid timeout',
      {
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            requestTimeoutMs: 0,
          },
        }),
      },
    ],
    [
      'invalid response-size limit',
      {
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            maxResponseBytes: -1,
          },
        }),
      },
    ],
  ])('rejects %s at startup', (_case, overrides) => {
    expect(() => parseAgentTransportConfiguration(environment(overrides))).toThrow(
      expect.objectContaining({
        code: 'HTTP_CONFIGURATION_INVALID',
        retryable: false,
      }),
    );
  });

  it('permits explicitly enabled development HTTP URLs', () => {
    const config = parseAgentTransportConfiguration(
      environment({
        HTTP_AGENT_ALLOW_INSECURE: 'true',
        HTTP_AGENT_CALLBACK_BASE_URL: 'http://127.0.0.1:3001',
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          ...httpConfiguration,
          'remote-security-reviewer': {
            ...httpConfiguration['remote-security-reviewer'],
            submitUrl: 'http://127.0.0.1:8080/v1/runs',
          },
        }),
      }),
    );

    expect(config.agents.get('remote-security-reviewer')?.kind).toBe('http');
  });

  it('does not expose secret values in validation errors', () => {
    expect(() =>
      parseAgentTransportConfiguration(
        environment({
          AGENT_TRANSPORT_CONFIG: JSON.stringify({
            ...httpConfiguration,
            'remote-security-reviewer': {
              ...httpConfiguration['remote-security-reviewer'],
              requestTimeoutMs: 'callback-secret',
            },
          }),
        }),
      ),
    ).toThrow(expect.not.objectContaining({ message: expect.stringContaining('callback-secret') }));
  });
});
