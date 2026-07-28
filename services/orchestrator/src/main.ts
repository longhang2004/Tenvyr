import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT || 3001;
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors();

  await app.listen(port);
  console.log(`Orchestrator Service is running on: http://localhost:${port}`);
}
bootstrap();
