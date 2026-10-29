import type { Request } from 'express';
import type { AppAccess, UserRole, UserStatus } from './auth.constants';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: UserRole;
  appAccess: AppAccess[];
  status: UserStatus;
  forcePasswordReset: boolean;
  lastLoginAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedRequestContext {
  session: AuthenticatedSession;
  user: PublicUser;
}

export type AuthenticatedRequest = Request & {
  auth?: AuthenticatedRequestContext;
};
