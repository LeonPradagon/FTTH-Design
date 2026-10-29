import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamps, timestamptz } from './_helpers';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerified: boolean('email_verified').default(true).notNull(),
    image: text('image'),
    passwordHash: text('password_hash'),
    role: varchar('role', { length: 32 }).notNull(),
    appAccess: text('app_access').array().notNull().default(sql`ARRAY['geospatial']::text[]`),
    banned: boolean('banned').default(false).notNull(),
    banReason: text('ban_reason'),
    banExpires: timestamptz('ban_expires'),
    status: varchar('status', { length: 32 }).default('active').notNull(),
    forcePasswordReset: boolean('force_password_reset').default(true).notNull(),
    lastLoginAt: timestamptz('last_login_at'),
    createdByUserId: uuid('created_by_user_id').references(
      (): AnyPgColumn => users.id,
      { onDelete: 'set null' },
    ),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_role_idx').on(table.role),
    index('users_status_idx').on(table.status),
  ],
);

export type UserRecord = typeof users.$inferSelect;
export type NewUserRecord = typeof users.$inferInsert;
