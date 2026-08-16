import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { selectBootstrapLogger, TenvyrDevLogger } from './dev-logger';

async function bootstrap() {
  const port = process.env.GATEWAY_PORT || 3000;
  // Terminal-UX closure: the compact presenter is a DEVELOPMENT-only
  // presentation. Production and verbose use NATIVE Nest logging.
  const loggerMode = selectBootstrapLogger();
  const devLogger = loggerMode === 'dev-normal' ? new TenvyrDevLogger() : undefined;
  const app = await NestFactory.create(AppModule, {
    ...(devLogger ? { logger: devLogger } : {}),
  });
  if (devLogger) app.useLogger(devLogger);

  // Enable CORS
  app.enableCors();

  await app.listen(port);
  (devLogger ?? console).log(`Gateway listening on http://localhost:${port}`);
}
bootstrap();
