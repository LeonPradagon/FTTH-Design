import { index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { timestamptz, timestamps } from './_helpers';

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: varchar('identifier', { length: 320 }).notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    ...timestamps,
  },
  (table) => [
    index('verifications_identifier_idx').on(table.identifier),
    index('verifications_expires_at_idx').on(table.expiresAt),
  ],
);

export type VerificationRecord = typeof verifications.$inferSelect;
export type NewVerificationRecord = typeof verifications.$inferInsert;
