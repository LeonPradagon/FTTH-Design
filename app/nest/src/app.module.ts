import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseModule } from './db/database.module';
import { ProjectsController } from './projects/projects.controller';
import { ConfigModule } from '@nestjs/config';
import { AuditController } from './audit/audit.controller';
import { VersionsController } from './versions/versions.controller';
import { FilesController } from './files/files.controller';
import { StorageModule } from './storage/storage.module';
import { GenerationController } from './generation/generation.controller';
import { GeneratorService } from './generation/generator.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '../.env', '.env'] }), DatabaseModule, StorageModule],
  controllers: [HealthController, ProjectsController, AuditController, VersionsController, FilesController, GenerationController],
  providers: [GeneratorService],
})
export class AppModule {}
