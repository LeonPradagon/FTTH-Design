import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as tables from '../../../nest/src/db/schema';

const globalForDb = globalThis as unknown as { pool?: Pool };
const pool = globalForDb.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

export const db = drizzle(pool, { schema: tables });
export const authSchema = {
  user: tables.users,
  session: tables.sessions,
  account: tables.accounts,
  verification: tables.verifications,
};
