import * as fs from 'fs';
import * as path from 'path';

describe('application transport boundary', () => {
  it.each([
    [
      'services/engine.service.ts',
      /kafkajs|KafkaService|KafkaAgentAdapter|HttpAgentAdapter|AgentAdapterRouter|AgentTransportConfigService/,
    ],
    [
      'services/agent-result.service.ts',
      /kafkajs|KafkaService|KafkaAgentAdapter|HttpAgentAdapter|HttpAgentCallbackController|\bfetch\b/,
    ],
  ])('%s stays transport-neutral', (relativePath, forbiddenDependency) => {
    const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

    expect(source).not.toMatch(forbiddenDependency);
  });

  it('binds the router at the composition root', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'app.module.ts'), 'utf8');

    expect(source).toMatch(/provide:\s*AGENT_ADAPTER,\s*useExisting:\s*AgentAdapterRouter/);
    expect(source).toMatch(/KafkaAgentAdapter/);
    expect(source).toMatch(/HttpAgentAdapter/);
  });

  it.each([
    'services/kafka.service.ts',
    'agent-adapters/kafka-agent.adapter.ts',
    'agent-adapters/http-agent.adapter.ts',
    'agent-adapters/agent-adapter.router.ts',
  ])('%s does not own Nest lifecycle hooks', (relativePath) => {
    const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');

    expect(source).not.toMatch(/OnModuleInit|OnModuleDestroy/);
  });

  it('captures raw body narrowly through Nest bootstrap', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');

    expect(source).toMatch(/NestFactory\.create\(AppModule,\s*\{\s*rawBody:\s*true\s*\}\)/);
  });
});
