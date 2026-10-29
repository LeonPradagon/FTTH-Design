import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateDrawnFeatureDto {
  @ApiProperty({
    description: 'Geometry table containing the drawn feature.',
    enum: ['Point', 'LineString', 'Polygon'],
  })
  @IsString()
  @IsIn(['Point', 'LineString', 'Polygon'])
  geometryType!: 'Point' | 'LineString' | 'Polygon';

  @ApiPropertyOptional({
    description: 'Updated display name for the drawn feature.',
    example: 'Coverage area 1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description for the drawn feature.',
    example: 'Edited from the browser editor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated style payload for drawn symbology.',
  })
  @IsOptional()
  @IsObject()
  style?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Updated metadata payload such as legend class selection.',
  })
  @IsOptional()
  @IsObject()
  rawProperties?: Record<string, unknown>;
}
