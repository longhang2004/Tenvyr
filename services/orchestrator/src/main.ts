import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TenvyrDevLogger } from './dev-logger';

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT || 3001;
  const logger = new TenvyrDevLogger();
  const app = await NestFactory.create(AppModule, { rawBody: true, logger });
  app.useLogger(logger);

  app.enableCors();

  // P2 shutdown-lifecycle closure: Nest signal hooks so a graceful
  // SIGTERM/SIGINT runs onModuleDestroy (OpenCodeAuthFlowService.closeAll
  // terminates every live management session and clears every timer)
  // before the process exits.
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Orchestrator listening on http://localhost:${port}`);
}
bootstrap();
