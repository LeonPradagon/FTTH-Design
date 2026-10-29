import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class ExportKmlDto {
  @ApiProperty({
    description: 'Province id whose geometry scopes exported features.',
    example: '31',
  })
  @IsString()
  provinceId!: string;

  @ApiPropertyOptional({
    description:
      'Visible selected imported folder ids. Omit to export all imported folders.',
    type: [String],
    example: [
      '7f36be9d-2816-4e35-9d58-52b280db79c8',
      '36487a5f-02da-4e4b-9634-7d900fa74865',
    ],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  folderIds?: string[];

  @ApiPropertyOptional({
    description:
      'Imported folder ids to exclude when exporting most folders. Omit to export all folders not otherwise filtered.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludedFolderIds?: string[];

  @ApiPropertyOptional({
    description:
      'Imported feature ids hidden in the layer tree. Hidden features are omitted from export.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hiddenFeatureIds?: string[];
}
