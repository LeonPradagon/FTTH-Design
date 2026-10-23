import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3001').split(',') });
  await app.listen(Number(process.env.PORT ?? 8000), '0.0.0.0');
}

void bootstrap();
