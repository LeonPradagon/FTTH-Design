import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn } from 'class-validator';
import { APP_ACCESS, type AppAccess } from '../auth.constants';

export class UpdateUserAppAccessDto {
  @ApiProperty({ enum: APP_ACCESS, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(APP_ACCESS, { each: true })
  appAccess: AppAccess[];
}
