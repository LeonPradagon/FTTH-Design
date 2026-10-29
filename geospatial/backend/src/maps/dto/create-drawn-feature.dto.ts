import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDrawnFeatureDto {
  @ApiPropertyOptional({
    description: 'Optional display name for the drawn feature.',
    example: 'Coverage area 1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Optional description for the drawn feature.',
    example: 'Draft polygon created from the browser editor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Optional persisted style payload for drawn symbology.',
    example: {
      pointColor: [37, 99, 235, 224],
      lineColor: [37, 99, 235, 255],
      fillColor: [37, 99, 235, 68],
    },
  })
  @IsOptional()
  @IsObject()
  style?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Optional metadata payload such as legend class selection.',
    example: {
      legendClassId: 'odp',
      legendClassName: 'ODP',
      source: 'drawn',
    },
  })
  @IsOptional()
  @IsObject()
  rawProperties?: Record<string, unknown>;

  @ApiProperty({
    description:
      'GeoJSON geometry payload. Supported types are Point, LineString, and Polygon.',
    example: {
      type: 'Point',
      coordinates: [106.8272, -6.1754],
    },
  })
  @IsObject()
  geometry!: Record<string, unknown>;
}
