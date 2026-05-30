import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { KafkaService } from './kafka.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [KafkaService],
})
export class AppModule {}
