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
      const parts = signed.split('|');
      if (parts.length < 5) throw new UnauthorizedException('Authentication required');
      const userId = parts[0], timestamp = parts[1], role = parts[2];
      const signature = parts.at(-1)!;
      const email = parts.slice(3, -1).join('|');
      const seconds = Number(timestamp.replaceAll('_', '').trim());
      if (!userId || !/^\s*[+-]?\d(?:_?\d)*\s*$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature) || !Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 60) {
        throw new UnauthorizedException('Authentication required');
      }
      const expected = createHmac('sha256', secret).update(`${userId}|${timestamp}|${role}|${email}`).digest();
      const actual = Buffer.from(signature, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Authentication required');
      request.user = { id: userId, role: role || 'user', email: email || '' };
      return true;
    }
    const userId = request.headers['x-user-id'];
    if (typeof userId !== 'string' || !userId) throw new UnauthorizedException('Authentication required');
    request.user = { id: userId, role: request.headers['x-user-role'] || 'user', email: request.headers['x-user-email'] || '' };
    return true;
  }
}
