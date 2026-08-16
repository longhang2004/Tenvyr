import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { selectBootstrapLogger, TenvyrDevLogger } from './dev-logger';

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT || 3001;
  // Terminal-UX closure: the compact presenter is a DEVELOPMENT-only
  // presentation. Production (NODE_ENV=production) and verbose
  // (TENVYR_LOG_LEVEL=verbose) use NATIVE Nest logging — lossless,
  // untruncated diagnostics; production semantics are never rewritten.
  const loggerMode = selectBootstrapLogger();
  const devLogger = loggerMode === 'dev-normal' ? new TenvyrDevLogger() : undefined;
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    ...(devLogger ? { logger: devLogger } : {}),
  });
  if (devLogger) app.useLogger(devLogger);

  app.enableCors();

  // P2 shutdown-lifecycle closure: Nest signal hooks so a graceful
  // SIGTERM/SIGINT runs onModuleDestroy (OpenCodeAuthFlowService.closeAll
  // terminates every live management session and clears every timer)
  // before the process exits.
  app.enableShutdownHooks();

  await app.listen(port);
  (devLogger ?? console).log(
    devLogger ? `Orchestrator listening on http://localhost:${port}` : `Nest application successfully started (orchestrator on :${port})`,
  );
}
bootstrap();
