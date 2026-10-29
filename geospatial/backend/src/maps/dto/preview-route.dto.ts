import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';

export class PreviewRouteDto {
  @ApiProperty({
    description:
      'Ordered Route Stops as [longitude, latitude] pairs. Adjacent stops are routed as independently filterable Route Segments.',
    example: [
      [106.8272, -6.1754],
      [106.8456, -6.2088],
    ],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(25)
  points!: unknown[];
}
