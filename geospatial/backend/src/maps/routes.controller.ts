import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { PreviewRouteDto } from './dto/preview-route.dto';
import { RoutesService } from './routes.service';

@ApiTags('maps')
@UseGuards(SessionAuthGuard)
@Controller('maps/:mapId/routes')
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Post('preview')
  @ApiOperation({
    summary:
      'Preview motor-scooter Route Segments from ordered Route Stops.',
  })
  @ApiOkResponse({
    description:
      'GraphHopper-backed Route Segment previews plus aggregate distance, duration, and fallback metadata.',
  })
  preview(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Body() payload: PreviewRouteDto,
  ) {
    return this.routesService.preview(mapId, payload);
  }
}
