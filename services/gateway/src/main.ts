import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TenvyrDevLogger } from './dev-logger';

async function bootstrap() {
  const port = process.env.GATEWAY_PORT || 3000;
  const logger = new TenvyrDevLogger();
  const app = await NestFactory.create(AppModule, { logger });
  app.useLogger(logger);
  
  // Enable CORS
  app.enableCors();

  await app.listen(port);
  logger.log(`Gateway listening on http://localhost:${port}`);
}
bootstrap();
