import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { EngineService } from './engine.service';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer;

  constructor(
    @Inject(forwardRef(() => EngineService))
    private engineService: EngineService,
  ) {
    const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
    const clientId = process.env.KAFKA_CLIENT_ID || 'agentweave-orchestrator';

    this.kafka = new Kafka({
      clientId,
      brokers,
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'agentweave-orchestrator-group' });
  }

  async onModuleInit() {
    console.log('Connecting to Kafka...');
    await this.producer.connect();
    await this.consumer.connect();
    console.log('Kafka Producer and Consumer connected.');

    const configuredAgents = (process.env.ORCHESTRATOR_AGENT_NAMES || 'code-reviewer,observability')
      .split(',')
      .map((agent) => agent.trim())
      .filter(Boolean);
    const configuredTopics = (process.env.ORCHESTRATOR_RESULT_TOPICS || '')
      .split(',')
      .map((topic) => topic.trim())
      .filter(Boolean);
    const resultTopics = Array.from(
      new Set([
        ...configuredAgents.map((agent) => `agentweave.agent.${agent}.result`),
        ...configuredTopics,
      ]),
    );

    for (const topic of resultTopics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
      console.log(`Subscribed to topic: ${topic}`);
    }

    // Start listening for messages
    this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        try {
          await this.handleKafkaMessage(payload);
        } catch (err) {
          console.error(`Error handling Kafka message from topic ${payload.topic}:`, err);
        }
      },
    });
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
    await this.consumer.disconnect();
  }

  async sendTask(
    agent: string,
    executionId: string,
    stepId: string,
    input: any,
    attempt = 1,
    maxAttempts = 1,
    timeout?: string | number,
  ) {
    const topic = `agentweave.agent.${agent}.task`;
    const payload = {
      executionId,
      stepId,
      agent,
      input,
      attempt,
      maxAttempts,
      timeout,
      timestamp: new Date().toISOString(),
    };

    console.log(`Publishing task for agent [${agent}] to topic [${topic}]:`, JSON.stringify(payload));

    await this.producer.send({
      topic,
      messages: [
        {
          key: executionId,
          value: JSON.stringify(payload),
        },
      ],
    });
  }

  private async handleKafkaMessage({ topic, message }: EachMessagePayload) {
    if (!message.value) return;
    const rawVal = message.value.toString();
    const payload = JSON.parse(rawVal);

    console.log(`Received result event on topic [${topic}]:`, rawVal);

    const { executionId, stepId, status, output, data, error, attempt } = payload;
    if (executionId && stepId && status) {
      await this.engineService.handleStepCompletion(
        executionId,
        stepId,
        status,
        output ?? data,
        error,
        attempt,
      );
    }
  }
}
