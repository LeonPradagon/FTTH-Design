import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { CreateDrawnFeatureDto } from './dto/create-drawn-feature.dto';
import { UpdateDrawnFeatureDto } from './dto/update-drawn-feature.dto';
import { DrawnFeaturesService } from './drawn-features.service';

@ApiTags('maps')
@UseGuards(SessionAuthGuard)
@Controller('maps/:mapId/drawn-features')
export class DrawnFeaturesController {
  constructor(private readonly drawnFeaturesService: DrawnFeaturesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a user-drawn point, line, or polygon for the active map.',
  })
  @ApiCreatedResponse({
    description:
      'The drawn feature was persisted in its dedicated geometry table.',
  })
  create(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Body() payload: CreateDrawnFeatureDto,
  ) {
    return this.drawnFeaturesService.create(mapId, payload);
  }

  @Patch(':featureId')
  @ApiOperation({
    summary: 'Update a saved user-drawn feature name, metadata, or style.',
  })
  @ApiOkResponse({
    description: 'The drawn feature was updated.',
  })
  update(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('featureId', new ParseUUIDPipe({ version: '4' })) featureId: string,
    @Body() payload: UpdateDrawnFeatureDto,
  ) {
    return this.drawnFeaturesService.update(mapId, featureId, payload);
  }

  @Delete(':featureId')
  @ApiOperation({
    summary: 'Delete a saved user-drawn feature.',
  })
  @ApiOkResponse({
    description: 'The drawn feature was deleted.',
  })
  remove(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('featureId', new ParseUUIDPipe({ version: '4' })) featureId: string,
    @Body() payload: UpdateDrawnFeatureDto,
  ) {
    return this.drawnFeaturesService.remove(
      mapId,
      featureId,
      payload.geometryType,
    );
  }
}
