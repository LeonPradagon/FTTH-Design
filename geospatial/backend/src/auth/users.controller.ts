import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { PublicUser } from './auth.types';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { ChangeMyPasswordDto } from './dto/change-my-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';
import { UpdateUserAppAccessDto } from './dto/update-user-app-access.dto';
import { RolesGuard } from './guards/roles.guard';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { UsersService } from './users.service';

@ApiTags('users')
@UseGuards(SessionAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List users for admin account management.' })
  @ApiOkResponse({ description: 'Users returned successfully.' })
  listUsers(@Req() request: Request) {
    return this.usersService.listUsers(request.headers);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create a new app user with a temporary password.' })
  @ApiCreatedResponse({ description: 'User created successfully.' })
  createUser(
    @Req() request: Request,
    @CurrentUser() user: PublicUser,
    @Body() dto: CreateUserDto,
  ) {
    return this.usersService.createAdminManagedUser(
      request.headers,
      dto,
      user.id,
    );
  }

  @Patch(':userId/app-access')
  @Roles('admin')
  @ApiOperation({ summary: 'Update the applications a user may access.' })
  @ApiOkResponse({ description: 'Application access updated successfully.' })
  updateAppAccess(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() dto: UpdateUserAppAccessDto,
  ) {
    return this.usersService.updateAppAccess(userId, dto.appAccess);
  }

  @Post('me/password')
  @ApiOperation({ summary: 'Change the current user password.' })
  @ApiOkResponse({ description: 'Password changed successfully.' })
  changeMyPassword(
    @Req() request: Request,
    @CurrentUser() user: PublicUser,
    @Body() dto: ChangeMyPasswordDto,
  ) {
    return this.usersService.changeOwnPassword(request.headers, {
      currentUserId: user.id,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      revokeOtherSessions: dto.revokeOtherSessions,
    });
  }

  @Delete(':userId')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a user account.' })
  @ApiOkResponse({ description: 'User deleted successfully.' })
  deleteUser(
    @Req() request: Request,
    @CurrentUser() user: PublicUser,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
  ) {
    return this.usersService.deleteAdminManagedUser(request.headers, {
      userId,
      currentUserId: user.id,
    });
  }

  @Post(':userId/reset-password')
  @Roles('admin')
  @ApiOperation({ summary: 'Reset a user password with a temporary password.' })
  @ApiOkResponse({ description: 'User password reset successfully.' })
  resetUserPassword(
    @Req() request: Request,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() dto: ResetUserPasswordDto,
  ) {
    return this.usersService.updatePasswordWithAdminSession(request.headers, {
      userId,
      password: dto.password,
    });
  }
}
