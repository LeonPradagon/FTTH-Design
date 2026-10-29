import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MapsService } from '../maps/maps.service';

async function main() {
  const [filePath, ...nameParts] = process.argv.slice(2);

  if (!filePath) {
    throw new Error(
      'Usage: npm run maps:import-kmz -- <path-to-.kmz-or-.kml-or-extracted-directory> [optional map name]',
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const mapsService = app.get(MapsService);
    const result = await mapsService.registerBootstrapKmz(
      filePath,
      nameParts.join(' '),
    );

    console.log(
      `Imported bootstrap source "${result.map.name}" with id ${result.map.id}.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
