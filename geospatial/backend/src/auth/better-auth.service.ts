import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { IncomingHttpHeaders } from 'http';
import { normalizeAppAccess, type UserRole, type UserStatus } from './auth.constants';
import type {
  AuthenticatedRequestContext,
  AuthenticatedSession,
  PublicUser,
} from './auth.types';
import { DatabaseService } from '../database/database.service';
import { accounts, sessions, users, verifications } from '../database/schemas';

type BetterAuthInstance = Awaited<
  ReturnType<BetterAuthService['createAuthInstance']>
>;

async function verifyLegacyPasswordHash(hash: string, password: string): Promise<boolean> {
  const [salt, key] = hash.split(':');
  if (!salt || !key || !/^[a-f\d]{128}$/i.test(key)) return false;

  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, 64, {
      N: 16_384,
      r: 16,
      p: 1,
      maxmem: 128 * 16_384 * 16 * 2,
    }, (error, result) => error ? reject(error) : resolve(result));
  });
  const expected = Buffer.from(key, 'hex');
  return expected.length === derived.length && timingSafeEqual(derived, expected);
}

@Injectable()
export class BetterAuthService {
  private authInstancePromise?: Promise<BetterAuthInstance>;
  private nodeHandlerPromise?: Promise<RequestHandler>;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  async getNodeHandler(): Promise<RequestHandler> {
    if (!this.nodeHandlerPromise) {
      this.nodeHandlerPromise = this.createNodeHandler();
    }

    return this.nodeHandlerPromise;
  }

  async getSessionFromHeaders(
    headers: IncomingHttpHeaders,
  ): Promise<AuthenticatedRequestContext | null> {
    const auth = await this.getAuthInstance();
    const authHeaders = await this.toBetterAuthHeaders(headers);
    const result = await auth.api.getSession({
      headers: authHeaders,
    });

    if (!result?.user || !result?.session) {
      return null;
    }

    return {
      user: this.toPublicUser(result.user),
      session: this.toAuthenticatedSession(result.session),
    };
  }

  async signUpEmail(input: { email: string; password: string; name: string }) {
    const auth = await this.getAuthInstance();

    return auth.api.signUpEmail({
      body: input,
    });
  }

  async createUser(
    headers: IncomingHttpHeaders,
    input: {
      email: string;
      password: string;
      name: string;
      role: UserRole;
    },
  ) {
    const auth = await this.getAuthInstance();

    return auth.api.createUser({
      headers: await this.toBetterAuthHeaders(headers),
      body: {
        email: input.email,
        password: input.password,
        name: input.name,
        role: input.role,
      } as any,
    });
  }

  async listUsers(headers: IncomingHttpHeaders) {
    const auth = await this.getAuthInstance();

    return auth.api.listUsers({
      headers: await this.toBetterAuthHeaders(headers),
      query: {
        limit: 200,
        sortBy: 'createdAt',
        sortDirection: 'desc',
      },
    });
  }

  async setUserPassword(
    headers: IncomingHttpHeaders,
    input: {
      userId: string;
      newPassword: string;
    },
  ) {
    const auth = await this.getAuthInstance();

    return auth.api.setUserPassword({
      headers: await this.toBetterAuthHeaders(headers),
      body: input,
    });
  }

  async removeUser(
    headers: IncomingHttpHeaders,
    input: {
      userId: string;
    },
  ) {
    const auth = await this.getAuthInstance();

    return auth.api.removeUser({
      headers: await this.toBetterAuthHeaders(headers),
      body: input,
    });
  }

  async changePassword(
    headers: IncomingHttpHeaders,
    input: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions?: boolean;
    },
  ) {
    const auth = await this.getAuthInstance();

    return auth.api.changePassword({
      headers: await this.toBetterAuthHeaders(headers),
      body: input,
    });
  }

  async updateUser(
    headers: IncomingHttpHeaders,
    input: {
      userId: string;
      data: Record<string, unknown>;
    },
  ) {
    const auth = await this.getAuthInstance();

    return auth.api.adminUpdateUser({
      headers: await this.toBetterAuthHeaders(headers),
      body: input,
    });
  }

  toPublicUser(user: any): PublicUser {
    return {
      id: String(user.id ?? ''),
      name: String(user.name ?? ''),
      email: String(user.email ?? ''),
      emailVerified: Boolean(user.emailVerified),
      image:
        typeof user.image === 'string' && user.image.trim().length > 0
          ? user.image
          : null,
      role: this.normalizeRole(user.role),
      appAccess: normalizeAppAccess(user.appAccess),
      status: this.normalizeStatus(user.status),
      forcePasswordReset: Boolean(user.forcePasswordReset),
      lastLoginAt: this.toDate(user.lastLoginAt),
      createdByUserId:
        typeof user.createdByUserId === 'string' ? user.createdByUserId : null,
      createdAt: this.toDate(user.createdAt) ?? new Date(0),
      updatedAt: this.toDate(user.updatedAt) ?? new Date(0),
    };
  }

  toAuthenticatedSession(session: any): AuthenticatedSession {
    return {
      id: String(session.id ?? ''),
      userId: String(session.userId ?? ''),
      token: typeof session.token === 'string' ? session.token : '',
      expiresAt: this.toDate(session.expiresAt) ?? new Date(0),
      createdAt: this.toDate(session.createdAt) ?? new Date(0),
      updatedAt: this.toDate(session.updatedAt) ?? new Date(0),
    };
  }

  private async getAuthInstance() {
    if (!this.authInstancePromise) {
      this.authInstancePromise = this.createAuthInstance();
    }

    return this.authInstancePromise;
  }

  private async createNodeHandler(): Promise<RequestHandler> {
    const auth = await this.getAuthInstance();
    const { toNodeHandler } = await import('better-auth/node');
    return toNodeHandler(auth);
  }

  private async toBetterAuthHeaders(headers: IncomingHttpHeaders) {
    const { fromNodeHeaders } = await import('better-auth/node');
    return fromNodeHeaders(headers);
  }

  private async createAuthInstance() {
    const [
      { betterAuth },
      { drizzleAdapter },
      { admin },
      { createAccessControl },
      { adminAc, defaultStatements },
      bcrypt,
    ] = await Promise.all([
      import('better-auth'),
      import('better-auth/adapters/drizzle'),
      import('better-auth/plugins'),
      import('better-auth/plugins/access'),
      import('better-auth/plugins/admin/access'),
      import('bcryptjs'),
    ]);
    const corsOrigin =
      this.configService.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173';
    const trustedOrigins = corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const accessControl = createAccessControl({
      ...defaultStatements,
    } as const);
    const adminRole = accessControl.newRole({
      ...adminAc.statements,
    });
    const staffRole = accessControl.newRole({});

    return betterAuth({
      appName: 'Geospatial',
      baseURL:
        this.configService.get<string>('BETTER_AUTH_URL') ??
        'http://localhost:3000',
      basePath: '/api/auth',
      trustedOrigins,
      database: drizzleAdapter(this.databaseService.db, {
        provider: 'pg',
        schema: {
          users,
          sessions,
          accounts,
          verifications,
        },
        camelCase: true,
        usePlural: true,
      }),
      emailAndPassword: {
        enabled: true,
        password: {
          hash: async (password) => bcrypt.hash(password, 12),
          verify: async ({ hash, password }) =>
            /^\$2[aby]\$\d\d\$/.test(hash)
              ? bcrypt.compare(password, hash)
              : verifyLegacyPasswordHash(hash, password),
        },
      },
      advanced: {
        database: {
          generateId: false,
        },
      },
      user: {
        additionalFields: {
          status: {
            type: ['active', 'disabled'],
            required: false,
            defaultValue: 'active',
            input: false,
          },
          forcePasswordReset: {
            type: 'boolean',
            required: false,
            defaultValue: true,
            input: false,
          },
          lastLoginAt: {
            type: 'date',
            required: false,
            input: false,
          },
          createdByUserId: {
            type: 'string',
            required: false,
            input: false,
          },
          appAccess: {
            type: 'string[]',
            required: false,
            defaultValue: ['geospatial'],
            input: false,
          },
        },
      },
      plugins: [
        admin({
          ac: accessControl,
          roles: {
            admin: adminRole,
            staff: staffRole,
          },
          defaultRole: 'staff',
        }),
      ],
    });
  }

  private normalizeRole(role: unknown): UserRole {
    return role === 'admin' ? 'admin' : 'staff';
  }

  private normalizeStatus(status: unknown): UserStatus {
    return status === 'disabled' ? 'disabled' : 'active';
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
  }
}
