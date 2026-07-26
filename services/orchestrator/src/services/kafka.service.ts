import { Injectable } from '@nestjs/common';
import { Consumer, EachMessagePayload, Kafka, Producer } from 'kafkajs';

export type KafkaPublishMessage = {
  topic: string;
  key: string;
  value: string;
};

export type KafkaMessageHandler = (payload: EachMessagePayload) => Promise<void>;

@Injectable()
export class KafkaService {
  private readonly producer: Producer;
  private readonly consumer: Consumer;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
    const clientId = process.env.KAFKA_CLIENT_ID || 'agentweave-orchestrator';
    const kafka = new Kafka({ clientId, brokers });

    this.producer = kafka.producer();
    this.consumer = kafka.consumer({
      groupId: 'agentweave-orchestrator-group',
    });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    await this.consumer.disconnect();
  }

  async publish(message: KafkaPublishMessage): Promise<void> {
    await this.producer.send({
      topic: message.topic,
      messages: [{ key: message.key, value: message.value }],
    });
  }

  async subscribe(topics: string[], handler: KafkaMessageHandler): Promise<void> {
    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
    await this.consumer.run({ eachMessage: handler });
  }
}
