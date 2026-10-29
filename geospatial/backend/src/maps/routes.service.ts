import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { maps } from '../database/schemas';
import { PreviewRouteDto } from './dto/preview-route.dto';
import { GraphHopperRoutingService } from './graphhopper-routing.service';

@Injectable()
export class RoutesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly graphHopperRoutingService: GraphHopperRoutingService,
  ) {}

  async preview(mapId: string, payload: PreviewRouteDto) {
    await this.assertMapExists(mapId);
    return this.graphHopperRoutingService.routeLineSegments(
      payload.points as [number, number][],
    );
  }

  private async assertMapExists(mapId: string) {
    const [mapRecord] = await this.databaseService.db
      .select({ id: maps.id })
      .from(maps)
      .where(eq(maps.id, mapId))
      .limit(1);

    if (!mapRecord) {
      throw new NotFoundException(`Map ${mapId} was not found.`);
    }
  }
}
