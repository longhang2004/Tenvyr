import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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
    this.consumer = this.kafka.consumer({ groupId: 'agentweave-observability-group' });
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
    const payload = JSON.parse(message.value.toString());
    const { executionId, stepId, input, attempt, timeout } = payload;

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

    try {
      // 3. Invoke Agent Runner (Java Spring Boot) HTTP endpoint
      console.log(`Calling Agent Runner at ${this.runnerUrl}/api/run`);
      const runnerData = await this.callRunner({
        promptTemplate,
        context: {
          executionId,
          stepId,
          attempt,
          logs: input.logs || 'No system logs available.',
          findings: JSON.stringify(input.findings || {}),
        },
        timeout,
      });

      const runnerOutput = runnerData.data.output;
      console.log(`Agent Runner output received:`, runnerOutput);

      // 4. Try parsing the response JSON
      let resultData: any = { status: 'HEALTHY', analysis: '', latencySec: 1 };
      try {
        const jsonMatch = runnerOutput.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          resultData = JSON.parse(jsonMatch[0]);
        } else {
          resultData = { status: 'DEGRADED', analysis: runnerOutput, latencySec: 2 };
        }
      } catch (err) {
        console.warn('Failed to parse Agent Runner output as JSON. Storing raw.');
        resultData = { status: 'DEGRADED', analysis: runnerOutput, latencySec: 2 };
      }

      // 5. Publish completion result event to result Kafka topic
      const resultPayload = {
        executionId,
        stepId,
        agent: 'observability',
        status: 'COMPLETED',
        output: resultData,
        attempt,
        timestamp: new Date().toISOString(),
      };

      console.log(`Publishing Observability result to agentweave.agent.observability.result`);
      await this.producer.send({
        topic: 'agentweave.agent.observability.result',
        messages: [{ key: executionId, value: JSON.stringify(resultPayload) }],
      });
    } catch (err) {
      console.error(`Execution failed for step ${stepId}:`, this.getErrorMessage(err));
      
      // Publish failure result event
      const failurePayload = {
        executionId,
        stepId,
        agent: 'observability',
        status: 'FAILED',
        error: this.getErrorMessage(err),
        attempt,
        timestamp: new Date().toISOString(),
      };

      await this.producer.send({
        topic: 'agentweave.agent.observability.result',
        messages: [{ key: executionId, value: JSON.stringify(failurePayload) }],
      });
    }
  }

  private async callRunner(payload: { promptTemplate: string; context: Record<string, unknown>; timeout?: string | number }) {
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
