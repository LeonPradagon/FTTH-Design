import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RegionsService } from './regions.service';

@Injectable()
export class RegionsBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegionsBootstrapService.name);

  constructor(private readonly regionsService: RegionsService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const summary =
        await this.regionsService.ensureBundledProvincesImported();

      if (summary.imported) {
        this.logger.log(
          `Bundled provinces imported (${summary.count} records).`,
        );
      } else {
        this.logger.log(
          `Bundled provinces already present (${summary.count} records).`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown province bootstrap error';
      this.logger.warn(`Province bootstrap skipped: ${message}`);
    }
  }
}
