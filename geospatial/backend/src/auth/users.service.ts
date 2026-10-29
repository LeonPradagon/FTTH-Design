import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  Injectable,
} from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { IncomingHttpHeaders } from 'http';
import { normalizeAppAccess, type AppAccess, type UserRole, type UserStatus } from './auth.constants';
import type { PublicUser } from './auth.types';
import { BetterAuthService } from './better-auth.service';
import { DatabaseService } from '../database/database.service';
import { accounts, users, type UserRecord } from '../database/schemas';

@Injectable()
export class UsersService {
  constructor(
    private readonly betterAuthService: BetterAuthService,
    private readonly databaseService: DatabaseService,
  ) {}

  async listUsers(headers: IncomingHttpHeaders): Promise<PublicUser[]> {
    const result = await this.betterAuthService.listUsers(headers);
    const rows = Array.isArray(result?.users) ? result.users : [];

    return rows.map((user) => this.betterAuthService.toPublicUser(user));
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [user] = await this.databaseService.db
      .select()
      .from(users)
      .where(eq(users.email, this.normalizeEmail(email)))
      .limit(1);

    return user ?? null;
  }

  async findById(userId: string): Promise<UserRecord | null> {
    const [user] = await this.databaseService.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return user ?? null;
  }

  async listUsersFromDatabase(): Promise<PublicUser[]> {
    const rows = await this.databaseService.db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt));

    return rows.map((user) => this.toPublicUser(user));
  }

  async createAdminManagedUser(
    headers: IncomingHttpHeaders,
    input: {
      email: string;
      password: string;
      role: UserRole;
      appAccess: AppAccess[];
    },
    createdByUserId: string | null,
  ): Promise<PublicUser> {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.findByEmail(email);
    if (existingUser) {
      throw new ConflictException(`User ${email} already exists.`);
    }

    const createdUser = await this.betterAuthService.createUser(headers, {
      email,
      password: input.password,
      name: this.nameFromEmail(email),
      role: input.role,
    });

    const createdUserRecord =
      'user' in createdUser ? createdUser.user : createdUser;
    const createdUserId = String(createdUserRecord.id ?? '');
    const [updatedUser] = await this.databaseService.db
      .update(users)
      .set({
        role: input.role,
        appAccess: input.appAccess,
        status: 'active',
        forcePasswordReset: true,
        createdByUserId,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, createdUserId))
      .returning();

    return updatedUser
      ? this.toPublicUser(updatedUser)
      : this.betterAuthService.toPublicUser(createdUserRecord);
  }

  async updateAppAccess(userId: string, appAccess: AppAccess[]): Promise<PublicUser> {
    const [updatedUser] = await this.databaseService.db
      .update(users)
      .set({ appAccess, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updatedUser) {
      throw new NotFoundException(`User ${userId} was not found.`);
    }

    return this.toPublicUser(updatedUser);
  }

  async deleteAdminManagedUser(
    headers: IncomingHttpHeaders,
    input: {
      userId: string;
      currentUserId: string;
    },
  ) {
    if (input.userId === input.currentUserId) {
      throw new BadRequestException('You cannot delete your own account.');
    }

    const user = await this.findById(input.userId);
    if (!user) {
      throw new NotFoundException(`User ${input.userId} was not found.`);
    }

    if (user.role === 'admin') {
      const [adminCountRow] = await this.databaseService.db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(users)
        .where(and(eq(users.role, 'admin'), ne(users.id, input.userId)));

      if (Number(adminCountRow?.count ?? 0) === 0) {
        throw new BadRequestException(
          'At least one admin account must remain.',
        );
      }
    }

    await this.betterAuthService.removeUser(headers, {
      userId: input.userId,
    });

    return {
      success: true,
      deletedUserId: input.userId,
      deletedEmail: user.email,
    };
  }

  async createBootstrapUser(input: {
    email: string;
    password: string;
    role: UserRole;
    createdByUserId: string | null;
    forcePasswordReset: boolean;
  }): Promise<PublicUser> {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.findByEmail(email);

    if (existingUser) {
      return this.toPublicUser(existingUser);
    }

    await this.betterAuthService.signUpEmail({
      email,
      password: input.password,
      name: this.nameFromEmail(email),
    });

    const [updatedUser] = await this.databaseService.db
      .update(users)
      .set({
        role: input.role,
        appAccess: ['geospatial', 'planner'],
        status: 'active',
        forcePasswordReset: input.forcePasswordReset,
        createdByUserId: input.createdByUserId,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(users.email, email))
      .returning();

    if (!updatedUser) {
      throw new NotFoundException(
        `Bootstrap user ${email} could not be finalized.`,
      );
    }

    return this.toPublicUser(updatedUser);
  }

  async reconcileBootstrapUser(
    existingUser: UserRecord,
    input: {
      password: string;
      role: UserRole;
      createdByUserId: string | null;
      forcePasswordReset: boolean;
    },
  ): Promise<PublicUser> {
    await this.ensureCredentialAccount(existingUser, input.password);

    const [updatedUser] = await this.databaseService.db
      .update(users)
      .set({
        role: input.role,
        status: 'active',
        forcePasswordReset: input.forcePasswordReset,
        createdByUserId: input.createdByUserId,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingUser.id))
      .returning();

    return this.toPublicUser(updatedUser ?? existingUser);
  }

  async updatePasswordWithAdminSession(
    headers: IncomingHttpHeaders,
    input: {
      userId: string;
      password: string;
    },
  ): Promise<PublicUser> {
    await this.betterAuthService.setUserPassword(headers, {
      userId: input.userId,
      newPassword: input.password,
    });

    const [updatedUser] = await this.databaseService.db
      .update(users)
      .set({
        forcePasswordReset: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId))
      .returning();

    if (!updatedUser) {
      throw new NotFoundException(`User ${input.userId} was not found.`);
    }

    return this.toPublicUser(updatedUser);
  }

  async changeOwnPassword(
    headers: IncomingHttpHeaders,
    input: {
      currentUserId: string;
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions?: boolean;
    },
  ): Promise<PublicUser> {
    await this.betterAuthService.changePassword(headers, {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      revokeOtherSessions: input.revokeOtherSessions ?? true,
    });

    const [updatedUser] = await this.databaseService.db
      .update(users)
      .set({
        forcePasswordReset: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.currentUserId))
      .returning();

    if (!updatedUser) {
      throw new NotFoundException(`User ${input.currentUserId} was not found.`);
    }

    return this.toPublicUser(updatedUser);
  }

  toPublicUser(
    user: Pick<
      UserRecord,
      | 'id'
      | 'name'
      | 'email'
      | 'emailVerified'
      | 'image'
      | 'role'
      | 'appAccess'
      | 'status'
      | 'forcePasswordReset'
      | 'lastLoginAt'
      | 'createdByUserId'
      | 'createdAt'
      | 'updatedAt'
    >,
  ): PublicUser {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image ?? null,
      role: user.role as UserRole,
      appAccess: normalizeAppAccess(user.appAccess),
      status: user.status as UserStatus,
      forcePasswordReset: user.forcePasswordReset,
      lastLoginAt: user.lastLoginAt ?? null,
      createdByUserId: user.createdByUserId ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private nameFromEmail(email: string) {
    const [localPart] = email.split('@', 1);
    return localPart ? localPart.replace(/[._-]+/g, ' ') : email;
  }

  private async ensureCredentialAccount(
    user: UserRecord,
    password: string,
  ): Promise<void> {
    const [existingAccount] = await this.databaseService.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, 'credential'),
        ),
      )
      .limit(1);

    if (existingAccount) {
      return;
    }

    const bcrypt = await import('bcryptjs');
    const passwordHash = user.passwordHash ?? (await bcrypt.hash(password, 12));

    await this.databaseService.db.insert(accounts).values({
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: passwordHash,
    });
  }
}
