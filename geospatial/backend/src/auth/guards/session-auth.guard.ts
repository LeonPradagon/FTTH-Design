import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth.types';
import { BetterAuthService } from '../better-auth.service';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly betterAuthService: BetterAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authContext = await this.betterAuthService.getSessionFromHeaders(
      request.headers,
    );
    if (!authContext) {
      throw new UnauthorizedException('Session is invalid or expired.');
    }

    request.auth = authContext;
    return true;
  }
}
