import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class FolderFilterQueryDto {
  @ApiPropertyOptional({
    description:
      'Optional comma-separated imported folder ids used to filter imported KML content.',
    example:
      '7f36be9d-2816-4e35-9d58-52b280db79c8,36487a5f-02da-4e4b-9634-7d900fa74865',
  })
  @IsOptional()
  @IsString()
  folderIds?: string;
}
