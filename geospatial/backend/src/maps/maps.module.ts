import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DrawnFeaturesController } from './drawn-features.controller';
import { DrawnFeaturesService } from './drawn-features.service';
import { MapsController } from './maps.controller';
import { MapImportService } from './map-import.service';
import { MapStyleResolverService } from './map-style-resolver.service';
import { MapsService } from './maps.service';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';
import { GraphHopperRoutingService } from './graphhopper-routing.service';

@Module({
  imports: [AuthModule],
  controllers: [MapsController, DrawnFeaturesController, RoutesController],
  providers: [
    DrawnFeaturesService,
    MapImportService,
    MapStyleResolverService,
    MapsService,
    RoutesService,
    GraphHopperRoutingService,
  ],
})
export class MapsModule {}
