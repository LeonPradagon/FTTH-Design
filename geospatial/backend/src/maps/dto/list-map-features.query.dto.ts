import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { FolderFilterQueryDto } from './folder-filter.query.dto';

export class ListMapFeaturesQueryDto extends FolderFilterQueryDto {
  @ApiPropertyOptional({
    description:
      'Province id whose geometry should be used to scope returned features.',
    example: '31',
  })
  @IsOptional()
  @IsString()
  provinceId?: string;

  @ApiPropertyOptional({
    description: 'Optional bbox filter as minLng,minLat,maxLng,maxLat.',
    example: '106.7,-6.3,106.95,-6.1',
  })
  @IsOptional()
  @IsString()
  bbox?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of features returned.',
    default: 5000,
    minimum: 1,
    maximum: 20000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20000)
  limit?: number;
}
