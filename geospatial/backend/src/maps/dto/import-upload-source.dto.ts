import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ImportUploadSourceDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'KML file uploaded from the browser.',
  })
  file!: unknown;

  @ApiPropertyOptional({
    description: 'Optional display name for the imported map.',
    example: 'FTTH Planning Package',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Use Auto Routing for imported Route Segments.',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    const rawValue = value as unknown;

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return undefined;
    }

    if (typeof rawValue === 'boolean') {
      return rawValue ? 'true' : 'false';
    }

    if (typeof rawValue === 'string') {
      return rawValue.trim().toLowerCase();
    }

    return rawValue;
  })
  @IsIn(['true', 'false'])
  autoRoute?: 'true' | 'false';
}
