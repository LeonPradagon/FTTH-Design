import { index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { timestamptz, timestamps } from './_helpers';
import { users } from './users.schema';

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    token: text('token'),
    tokenHash: varchar('token_hash', { length: 64 }),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 64 }),
    impersonatedBy: uuid('impersonated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    ...timestamps,
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
    index('sessions_token_idx').on(table.token),
    index('sessions_token_hash_idx').on(table.tokenHash),
  ],
);

export type SessionRecord = typeof sessions.$inferSelect;
export type NewSessionRecord = typeof sessions.$inferInsert;
