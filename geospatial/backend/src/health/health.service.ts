import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class HealthService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getHealth() {
    const timestamp = new Date().toISOString();

    try {
      const database = await this.databaseService.checkHealth();

      if (!database.postgisEnabled) {
        throw new ServiceUnavailableException({
          status: 'degraded',
          service: 'geospatial-backend',
          timestamp,
          database,
          error:
            'Database is reachable, but the PostGIS extension is not enabled.',
        });
      }

      return {
        status: 'ok',
        service: 'geospatial-backend',
        timestamp,
        database,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new ServiceUnavailableException({
        status: 'error',
        service: 'geospatial-backend',
        timestamp,
        database: {
          status: 'down',
        },
        error:
          error instanceof Error
            ? error.message
            : 'Unknown database connectivity error.',
      });
    }
  }
}
