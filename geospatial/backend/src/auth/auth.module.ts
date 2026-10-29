import { Module } from '@nestjs/common';
import { AuthBootstrapService } from './auth-bootstrap.service';
import { BetterAuthService } from './better-auth.service';
import { RolesGuard } from './guards/roles.guard';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [
    AuthBootstrapService,
    BetterAuthService,
    RolesGuard,
    SessionAuthGuard,
    UsersService,
  ],
  exports: [BetterAuthService, RolesGuard, SessionAuthGuard, UsersService],
})
export class AuthModule {}
