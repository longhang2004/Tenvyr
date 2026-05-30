import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { databaseProviders } from './database/database.provider';
import { repositoryProviders } from './database/repository.providers';
import { PipelineService } from './services/pipeline.service';
import { ExecutionService } from './services/execution.service';
import { KafkaService } from './services/kafka.service';
import { EngineService } from './services/engine.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    ...databaseProviders,
    ...repositoryProviders,
    PipelineService,
    ExecutionService,
    KafkaService,
    EngineService,
  ],
  exports: [
    ...databaseProviders,
    ...repositoryProviders,
    PipelineService,
    ExecutionService,
    KafkaService,
    EngineService,
  ],
})
export class AppModule {}
