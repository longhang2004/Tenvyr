import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = process.env.GATEWAY_PORT || 3000;
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS
  app.enableCors();

  await app.listen(port);
  console.log(`Gateway Service is running on: http://localhost:${port}`);
}
bootstrap();
