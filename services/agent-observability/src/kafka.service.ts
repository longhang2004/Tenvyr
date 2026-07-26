import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  AgentInvocationV1,
  AgentResultV1,
  ContractValidationError,
  normalizeLegacyInvocation,
  parseAgentInvocation,
  parseAgentResult,
} from '@agentweave/contracts';
import { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer;
  private runnerUrl: string;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
    this.kafka = new Kafka({
      clientId: 'agent-observability',
      brokers,
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({
      groupId: 'agentweave-observability-group',
    });
    this.runnerUrl = process.env.AGENT_RUNNER_URL || 'http://localhost:8085';
  }

  async onModuleInit() {
    console.log('Observability Agent connecting to Kafka...');
    await this.producer.connect();
    await this.consumer.connect();
    console.log('Observability Agent connected to Kafka.');

    const topic = 'agentweave.agent.observability.task';
    await this.consumer.subscribe({ topic, fromBeginning: false });
    console.log(`Observability Agent subscribed to topic: ${topic}`);

    this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        try {
          await this.processTask(payload);
        } catch (err) {
          console.error('Error processing observability task:', this.getErrorMessage(err));
        }
      },
    });
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
    await this.consumer.disconnect();
  }

  private async processTask({ message }: EachMessagePayload) {
    if (!message.value) return;
    let invocation: AgentInvocationV1;
    let payload: unknown;

    try {
      payload = JSON.parse(message.value.toString());
      invocation = this.normalizeInvocation(payload, message.timestamp);
    } catch (error) {
      this.logInvalidInvocation(error, payload, message.key?.toString());
      return;
    }

    const { executionId, stepId, input, attempt } = invocation;

    console.log(`Observability Agent received task for execution [${executionId}], step [${stepId}]`);

    // 1. Read observability guidelines from skills/ directory
    let skillRules = 'Analyze system log files and identify performance bottlenecks and timeouts.';
    try {
      const skillPath = path.resolve(__dirname, '../../../skills/observability-guidelines.md');
      if (fs.existsSync(skillPath)) {
        skillRules = fs.readFileSync(skillPath, 'utf8');
      }
    } catch (err) {
      console.warn('Failed to load skill rules from file, using fallback.', this.getErrorMessage(err));
    }

    // 2. Build prompt template
    const promptTemplate = `
      You are an operations diagnostic agent. Apply the following guidelines:
      ${skillRules}
      
      Diagnose the system performance logs:
      Logs:
      {{logs}}
      
      Review Findings:
      {{findings}}

      Please return a clean JSON payload ONLY containing:
      {
        "status": "HEALTHY" | "DEGRADED" | "CRITICAL",
        "analysis": "<diagnostic analysis summary>",
        "latencySec": <estimated overall step latency>
      }
    `;

    const startedAt = new Date().toISOString();
    try {
      if (!this.isRecord(input)) throw new Error('Observability input must be an object');

      // 3. Invoke Agent Runner (Java Spring Boot) HTTP endpoint
      console.log(`Calling Agent Runner at ${this.runnerUrl}/api/run`);
      const runnerData = await this.callRunner({
        promptTemplate,
        context: {
          executionId,
          stepId,
          attempt,
          logs: typeof input.logs === 'string' ? input.logs : 'No system logs available.',
          findings: JSON.stringify(input.findings || {}),
        },
        timeout: this.remainingTimeout(invocation),
      });

      const runnerOutput = runnerData.data.output;

      // 4. Try parsing the response JSON
      let resultData: any = { status: 'HEALTHY', analysis: '', latencySec: 1 };
      try {
        const jsonMatch = runnerOutput.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          resultData = JSON.parse(jsonMatch[0]);
        } else {
          resultData = {
            status: 'DEGRADED',
            analysis: runnerOutput,
            latencySec: 2,
          };
        }
      } catch (err) {
        console.warn('Failed to parse Agent Runner output as JSON. Storing raw.');
        resultData = {
          status: 'DEGRADED',
          analysis: runnerOutput,
          latencySec: 2,
        };
      }

      // 5. Publish completion result event to result Kafka topic
      const resultPayload = parseAgentResult({
        schemaVersion: '1',
        invocationId: invocation.invocationId,
        executionId,
        stepExecutionId: invocation.stepExecutionId,
        status: 'succeeded',
        output: resultData,
        startedAt,
        completedAt: new Date().toISOString(),
      });

      console.log(`Publishing Observability result to agentweave.agent.observability.result`);
      await this.publishResult(resultPayload);
    } catch (err) {
      console.error(`Execution failed for step ${stepId}:`, this.getErrorMessage(err));

      // Publish failure result event
      const timedOut = err instanceof Error && err.name === 'AbortError';
      const failurePayload = parseAgentResult({
        schemaVersion: '1',
        invocationId: invocation.invocationId,
        executionId,
        stepExecutionId: invocation.stepExecutionId,
        status: timedOut ? 'timed_out' : 'failed',
        error: {
          code: timedOut ? 'AGENT_TIMED_OUT' : 'AGENT_EXECUTION_FAILED',
          message: this.getErrorMessage(err),
          retryable: timedOut,
        },
        startedAt,
        completedAt: new Date().toISOString(),
      });

      await this.publishResult(failurePayload);
    }
  }

  private normalizeInvocation(value: unknown, kafkaTimestamp: string): AgentInvocationV1 {
    if (this.isRecord(value) && value.schemaVersion === '1') {
      const invocation = parseAgentInvocation(value);
      if (invocation.target.agent !== 'observability') {
        throw new ContractValidationError('AgentInvocationV1', [
          {
            path: '/target/agent',
            message: 'must be observability for this topic',
            keyword: 'const',
          },
        ]);
      }
      return invocation;
    }

    const executionId = this.stringField(value, 'executionId') || '';
    const stepId = this.stringField(value, 'stepId') || '';
    const attempt = this.isRecord(value) && Number.isInteger(value.attempt) ? (value.attempt as number) : Number.NaN;
    const stepExecutionId = `legacy:${executionId}:${stepId}`;
    const invocationId = `${stepExecutionId}:${attempt}`;

    return normalizeLegacyInvocation(value, {
      invocationId,
      executionId,
      stepExecutionId,
      stepId,
      agent: 'observability',
      attempt,
      traceId: executionId,
      correlationId: invocationId,
      createdAt: this.createdAt(value, kafkaTimestamp),
    });
  }

  private async publishResult(result: AgentResultV1): Promise<void> {
    await this.producer.send({
      topic: 'agentweave.agent.observability.result',
      messages: [{ key: result.executionId, value: JSON.stringify(result) }],
    });
  }

  private remainingTimeout(invocation: AgentInvocationV1): number | undefined {
    if (!invocation.deadlineAt) return undefined;
    return Math.max(Date.parse(invocation.deadlineAt) - Date.now(), 1);
  }

  private createdAt(value: unknown, kafkaTimestamp: string): string {
    if (this.isRecord(value) && typeof value.timestamp === 'string') return value.timestamp;
    const milliseconds = Number(kafkaTimestamp);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
  }

  private stringField(value: unknown, field: string): string | undefined {
    return this.isRecord(value) && typeof value[field] === 'string' ? value[field] : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private logInvalidInvocation(error: unknown, value: unknown, messageKey?: string): void {
    const executionId = this.stringField(value, 'executionId');
    if (error instanceof ContractValidationError) {
      console.error('Rejected invalid observability invocation', {
        contract: error.contract,
        issues: error.issues,
        executionId,
        messageKey,
      });
      return;
    }
    console.error('Rejected unreadable observability invocation', {
      contract: 'AgentInvocationV1',
      issues: [{ path: '/', message: this.getErrorMessage(error) }],
      executionId,
      messageKey,
    });
  }

  private async callRunner(payload: {
    promptTemplate: string;
    context: Record<string, unknown>;
    timeout?: string | number;
  }) {
    const timeoutMs = this.parseDurationMs(payload.timeout) || 60_000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.runnerUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptTemplate: payload.promptTemplate,
          context: payload.context,
        }),
        signal: controller.signal,
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Agent Runner returned HTTP ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private parseDurationMs(duration: string | number | undefined): number | null {
    if (duration === undefined || duration === null) return null;
    if (typeof duration === 'number') return duration > 0 ? duration : null;

    const match = duration.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
    };

    return value * multipliers[unit];
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
