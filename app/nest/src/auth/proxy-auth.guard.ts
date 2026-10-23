import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class ProxyAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const secret = process.env.BACKEND_PROXY_SECRET || process.env.BETTER_AUTH_SECRET;
    const signed = request.headers['x-proxy-auth'];
    if (secret) {
      if (typeof signed !== 'string') throw new UnauthorizedException('Authentication required');
      const [userId, timestamp, role, email, signature] = signed.split('|');
      const seconds = Number(timestamp);
      if (!userId || !signature || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 60) {
        throw new UnauthorizedException('Authentication required');
      }
      const expected = createHmac('sha256', secret).update(`${userId}|${timestamp}|${role}|${email}`).digest();
      let actual: Buffer;
      try { actual = Buffer.from(signature, 'hex'); } catch { throw new UnauthorizedException('Authentication required'); }
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Authentication required');
      request.user = { id: userId, role: role || 'user', email: email || '' };
      return true;
    }
    const userId = request.headers['x-user-id'];
    if (!userId) throw new UnauthorizedException('Authentication required');
    request.user = { id: userId, role: request.headers['x-user-role'] || 'user', email: request.headers['x-user-email'] || '' };
    return true;
  }
}
