import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check API and database connectivity.' })
  @ApiOkResponse({ description: 'API and database are reachable.' })
  @ApiServiceUnavailableResponse({
    description:
      'API is up but its database or PostGIS dependency is unavailable.',
  })
  getHealth() {
    return this.healthService.getHealth();
  }
}
