import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, basename, extname, join } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';
import { GeneratorService, readKml } from '../generation/generator.service';

function argument(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function help() {
  process.stdout.write(`FTTH design generator (NestJS)\n\nUsage:\n  npm run design:generate -- --input area.kmz [options]\n  npm run design:generate -- --boundary area.kml --pop olt.kml [options]\n\nOptions:\n  --output file.kmz            Output KMZ (default: design_ftth.kmz)\n  --odp-capacity number        Houses per ODP (default: 10)\n  --odc-capacity number        ODPs per ODC (default: 4)\n  --routing-strategy value    shortest or priority_road (default: priority_road, with the default CLI strategy)\n  --target-homepass number     Keep nearest houses to POP\n  --houses file.kml|file.kmz   Use manually digitized houses\n  --no-road-feeder             Use straight feeder/distribution cables\n  --odc-min-distance-m number  Minimum distance between ODCs (default: 40)\n  --show-homepass              Include houses and drop cables in KMZ\n`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) return help();
  const input = argument('--input');
  const boundaryPath = input ?? argument('--boundary');
  const popPath = input ?? argument('--pop');
  if (!boundaryPath || !popPath || (!input && !(argument('--boundary') && argument('--pop')))) {
    throw new Error('Gunakan --input file.kmz atau --boundary file.kml --pop file.kml.');
  }
  const output = resolve(argument('--output', 'design_ftth.kmz')!);
  const boundaryName = basename(boundaryPath), popName = basename(popPath);
  const boundaryBytes = await readFile(boundaryPath), popBytes = input ? boundaryBytes : await readFile(popPath);
  const manualPath = argument('--houses');
  const manualHouses = manualPath
    ? (await readKml(await readFile(manualPath), basename(manualPath))).flatMap((mark, index) => mark.point ? [{ label: mark.name || `HOUSE-${index + 1}`, at: mark.point }] : [])
    : undefined;
  const options = {
    odp_capacity: Number(argument('--odp-capacity', '10')),
    odc_capacity: Number(argument('--odc-capacity', '4')),
    routing_strategy: argument('--routing-strategy', 'priority_road'),
    target_homepass: argument('--target-homepass') === undefined ? undefined : Number(argument('--target-homepass')),
    odc_min_distance_m: Number(argument('--odc-min-distance-m', '40')),
    include_homepass: process.argv.includes('--show-homepass'),
    include_boundary: false,
    no_road_feeder: process.argv.includes('--no-road-feeder'),
    allow_road_fallback: true,
    manual_houses: manualHouses,
  };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const generator = new GeneratorService(drizzle(pool, { schema }));
    const result = await generator.generate(boundaryBytes, boundaryName, popBytes, popName, options);
    await writeFile(output, result.kmz);
    const csvPath = join(dirname(output), `${basename(output, extname(output))}.csv`);
    await writeFile(csvPath, result.csv);
    process.stdout.write(`${JSON.stringify({ output, csv: csvPath, stats: result.stats }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
