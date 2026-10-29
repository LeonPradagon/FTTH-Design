import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Response } from 'express';
import type { PublicUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { FolderFilterQueryDto } from './dto/folder-filter.query.dto';
import { ExportKmlDto } from './dto/export-kml.dto';
import { FolderFilterBodyDto } from './dto/folder-filter.body.dto';
import { ImportUploadSourceDto } from './dto/import-upload-source.dto';
import { ListMapFeaturesBodyDto } from './dto/list-map-features.body.dto';
import { ListMapFeaturesQueryDto } from './dto/list-map-features.query.dto';
import type { UploadedMapFile } from './map-import.service';
import { MapsService } from './maps.service';

const MAP_UPLOAD_DIRECTORY = join(tmpdir(), 'geospatial-map-uploads');
mkdirSync(MAP_UPLOAD_DIRECTORY, { recursive: true });

@ApiTags('maps')
@UseGuards(SessionAuthGuard, RolesGuard)
@Controller('maps')
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  @Get()
  @ApiOperation({ summary: 'List imported map packages.' })
  @ApiOkResponse({
    description: 'Bootstrap-imported maps ordered from newest to oldest.',
  })
  findAll() {
    return this.mapsService.findAll();
  }

  @Get('upload-history')
  @Roles('admin')
  @ApiOperation({ summary: 'List map package upload history.' })
  @ApiOkResponse({
    description: 'Map package uploads ordered from newest to oldest.',
  })
  listUploadHistory() {
    return this.mapsService.listUploadHistory();
  }

  @Delete(':mapId')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a map package and its imported data.' })
  @ApiOkResponse({
    description: 'The map package was deleted.',
  })
  deleteMapPackage(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
  ) {
    return this.mapsService.deleteMapPackage(mapId);
  }

  @Get(':mapId/tree')
  @ApiOperation({ summary: 'Return the imported folder tree for a map.' })
  @ApiOkResponse({ description: 'Folder hierarchy with descendant counts.' })
  async getTree(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
  ): Promise<unknown> {
    return this.mapsService.getTree(mapId);
  }

  @Get(':mapId/features')
  @ApiOperation({
    summary: 'Return filtered map features for a selected province.',
  })
  @ApiOkResponse({
    description:
      'FeatureCollection scoped to a selected province and an optional bbox.',
  })
  getFeatures(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Query() query: ListMapFeaturesQueryDto,
  ): Promise<unknown> {
    return this.mapsService.getFeatures(mapId, query);
  }

  @Post(':mapId/features')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return filtered map features for a selected province.',
  })
  @ApiOkResponse({
    description:
      'FeatureCollection scoped to a selected province and an optional bbox.',
  })
  postFeatures(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Body() body: ListMapFeaturesBodyDto,
  ): Promise<unknown> {
    return this.mapsService.getFeatures(mapId, body);
  }

  @Post(':mapId/provinces/suggest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suggest the best province for selected imported folders.',
  })
  @ApiOkResponse({
    description:
      'The province with the strongest imported feature overlap for the folder selection.',
  })
  suggestProvince(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Body() body: FolderFilterBodyDto,
  ): Promise<unknown> {
    return this.mapsService.suggestProvince(mapId, body);
  }

  @Post(':mapId/export/kml')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Export selected province and visible selected folders as KML.',
  })
  @ApiOkResponse({
    description: 'Plain KML file download.',
  })
  async exportKml(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Body() body: ExportKmlDto,
    @Res() response: Response,
  ) {
    const result = await this.mapsService.exportKml(mapId, body);

    response.setHeader(
      'Content-Type',
      'application/vnd.google-earth.kml+xml; charset=utf-8',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    response.send(result.content);
  }

  @Post(':mapId/export/csv')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Export selected province and visible selected folders as CSV.',
  })
  @ApiOkResponse({
    description: 'Plain CSV file download.',
  })
  async exportCsv(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Body() body: ExportKmlDto,
    @Res() response: Response,
  ) {
    const result = await this.mapsService.exportCsv(mapId, body);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    response.send(result.content);
  }

  @Get(':mapId/provinces/:provinceId/points/summary')
  @ApiOperation({
    summary: 'Return point summary metrics for a selected province.',
  })
  @ApiOkResponse({
    description: 'Total imported point count for the selected province.',
  })
  getPointSummary(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('provinceId') provinceId: string,
    @Query() query: FolderFilterQueryDto,
  ): Promise<unknown> {
    return this.mapsService.getPointSummary(mapId, provinceId, query);
  }

  @Post(':mapId/provinces/:provinceId/points/summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return point summary metrics for a selected province.',
  })
  @ApiOkResponse({
    description: 'Total imported point count for the selected province.',
  })
  postPointSummary(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('provinceId') provinceId: string,
    @Body() body: FolderFilterBodyDto,
  ): Promise<unknown> {
    return this.mapsService.getPointSummary(mapId, provinceId, body);
  }

  @Get(':mapId/provinces/:provinceId/points/tiles/:z/:x/:y')
  @ApiOperation({
    summary: 'Return raw imported points for one province tile.',
  })
  @ApiOkResponse({
    description:
      'Lightweight point payload for the selected province and tile.',
  })
  getPointTile(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('provinceId') provinceId: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Query() query: FolderFilterQueryDto,
  ): Promise<unknown> {
    return this.mapsService.getPointTile(mapId, provinceId, z, x, y, query);
  }

  @Post(':mapId/provinces/:provinceId/points/tiles/:z/:x/:y')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return raw imported points for one province tile.',
  })
  @ApiOkResponse({
    description:
      'Lightweight point payload for the selected province and tile.',
  })
  postPointTile(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('provinceId') provinceId: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Body() body: FolderFilterBodyDto,
  ): Promise<unknown> {
    return this.mapsService.getPointTile(mapId, provinceId, z, x, y, body);
  }

  @Get(':mapId/provinces/:provinceId/point-clusters/tiles/:z/:x/:y')
  @ApiOperation({
    summary: 'Return clustered imported points for one province tile.',
  })
  @ApiOkResponse({
    description:
      'Clustered point summaries for low-zoom province tile rendering.',
  })
  getPointClusterTile(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('provinceId') provinceId: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Query() query: FolderFilterQueryDto,
  ): Promise<unknown> {
    return this.mapsService.getPointClusterTile(
      mapId,
      provinceId,
      z,
      x,
      y,
      query,
    );
  }

  @Post(':mapId/provinces/:provinceId/point-clusters/tiles/:z/:x/:y')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return clustered imported points for one province tile.',
  })
  @ApiOkResponse({
    description:
      'Clustered point summaries for low-zoom province tile rendering.',
  })
  postPointClusterTile(
    @Param('mapId', new ParseUUIDPipe({ version: '4' })) mapId: string,
    @Param('provinceId') provinceId: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Body() body: FolderFilterBodyDto,
  ): Promise<unknown> {
    return this.mapsService.getPointClusterTile(
      mapId,
      provinceId,
      z,
      x,
      y,
      body,
    );
  }

  @Post('import-upload')
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: MAP_UPLOAD_DIRECTORY,
    }),
  )
  @ApiOperation({ summary: 'Upload and import a KML source.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ImportUploadSourceDto })
  @ApiOkResponse({
    description: 'Imported map metadata after upload parsing is complete.',
  })
  importUploadedSource(
    @UploadedFile() file: UploadedMapFile | undefined,
    @Body() body: ImportUploadSourceDto,
    @CurrentUser() user: PublicUser,
  ) {
    if (!file) {
      throw new BadRequestException('A KML file upload is required.');
    }

    return this.mapsService.registerUploadedSource(
      file,
      body.name,
      user.id,
      body.autoRoute !== 'false',
    );
  }
}
