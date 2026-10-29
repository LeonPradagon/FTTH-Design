import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { RegionsService } from './regions.service';

@ApiTags('provinces')
@UseGuards(SessionAuthGuard)
@Controller('provinces')
export class RegionsController {
  constructor(private readonly regionsService: RegionsService) {}

  @Get()
  @ApiOperation({ summary: 'Return Indonesian province polygons as GeoJSON.' })
  @ApiOkResponse({
    description:
      'FeatureCollection of provinces used for area-based planning selection.',
  })
  findAll(): Promise<unknown> {
    return this.regionsService.listProvinces();
  }
}
