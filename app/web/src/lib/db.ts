import { Pool } from 'pg';

const globalForDb = globalThis as unknown as { pool?: Pool };
const pool = globalForDb.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

export async function ensurePlannerUser(user: {
  id: string;
  name?: string | null;
  email: string;
  role?: string | null;
}) {
  const email = user.email.trim().toLowerCase();
  const role = user.role === 'admin' ? 'admin' : 'engineer';
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1',
    [email],
  );

  if (existing.rows[0]) {
    const updated = await pool.query<{ id: string }>(
      'UPDATE "user" SET name = $1, role = $2, "updatedAt" = now() WHERE id = $3 RETURNING id',
      [user.name || email, role, existing.rows[0].id],
    );
    return updated.rows[0].id;
  }

  const created = await pool.query<{ id: string }>(
    'INSERT INTO "user" (id, name, email, "emailVerified", role) VALUES ($1, $2, $3, true, $4) ON CONFLICT (email) DO NOTHING RETURNING id',
    [user.id, user.name || email, email, role],
  );
  if (created.rows[0]) return created.rows[0].id;

  const raced = await pool.query<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1',
    [email],
  );
  if (!raced.rows[0]) throw new Error('Could not link the Geospatial account to FTTH Planner.');
  return raced.rows[0].id;
}
