import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Injectable()
export class DatabaseBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseBootstrapService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.databaseService.ensurePostgis();
      this.logger.log('PostGIS extension is ready.');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown database bootstrap error';
      this.logger.warn(`Database bootstrap skipped: ${message}`);
    }
  }
}
