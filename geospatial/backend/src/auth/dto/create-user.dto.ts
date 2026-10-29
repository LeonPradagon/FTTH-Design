import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsEmail, IsIn, IsString, MinLength } from 'class-validator';
import { APP_ACCESS, USER_ROLES, type AppAccess, type UserRole } from '../auth.constants';

export class CreateUserDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ enum: USER_ROLES, example: 'staff' })
  @IsString()
  @IsIn(USER_ROLES)
  role: UserRole;

  @ApiProperty({ enum: APP_ACCESS, isArray: true, example: ['geospatial', 'planner'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(APP_ACCESS, { each: true })
  appAccess: AppAccess[];
}
