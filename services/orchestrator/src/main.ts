import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT || 3001;
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors();

  // P2 shutdown-lifecycle closure: Nest signal hooks so a graceful
  // SIGTERM/SIGINT runs onModuleDestroy (OpenCodeAuthFlowService.closeAll
  // terminates every live management session and clears every timer)
  // before the process exits.
  app.enableShutdownHooks();

  await app.listen(port);
  console.log(`Orchestrator Service is running on: http://localhost:${port}`);
}
bootstrap();
