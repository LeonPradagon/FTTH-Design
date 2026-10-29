import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RegionsService } from '../regions/regions.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const regionsService = app.get(RegionsService);
    const result = await regionsService.importBundledProvinces();

    console.log(`Imported ${result.count} provinces from bundled GeoJSON.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
