import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { validateEnvironment } from './config/environment.validation';
import { HealthModule } from './health/health.module';
import { MapsModule } from './maps/maps.module';
import { RegionsModule } from './regions/regions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      validate: validateEnvironment,
    }),
    AuthModule,
    DatabaseModule,
    HealthModule,
    MapsModule,
    RegionsModule,
  ],
})
export class AppModule {}
