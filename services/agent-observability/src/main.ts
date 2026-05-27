import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = process.env.PORT || 3003;
  const app = await NestFactory.create(AppModule);
  
  app.enableCors();

  await app.listen(port);
  console.log(`Agent Observability Service is running on: http://localhost:${port}`);
}
bootstrap();
