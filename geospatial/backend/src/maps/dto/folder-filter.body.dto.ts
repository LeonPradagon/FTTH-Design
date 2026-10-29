import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class FolderFilterBodyDto {
  @ApiPropertyOptional({
    description:
      'Optional imported folder ids used to filter imported KML content.',
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
}
