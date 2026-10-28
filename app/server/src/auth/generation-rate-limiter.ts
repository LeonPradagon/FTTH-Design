import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';

@Injectable()
export class GenerationRateLimiter {
  private requests = 0;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async consume(userId: string, response?: any) {
    const limit = Math.max(1, Number(process.env.GENERATION_RATE_LIMIT ?? 10));
    const seconds = Math.max(1, Number(process.env.GENERATION_RATE_WINDOW_SECONDS ?? 60));
    const now = Math.floor(Date.now() / 1000), windowIndex = Math.floor(now / seconds);
    let count: number;
    try {
      const result = await this.pool.query(`
        INSERT INTO generation_rate_limit ("userId", "windowIndex", count, "updatedAt")
        VALUES ($1, $2, 1, NOW())
        ON CONFLICT ("userId") DO UPDATE SET
          "windowIndex" = EXCLUDED."windowIndex",
          count = CASE WHEN generation_rate_limit."windowIndex" = EXCLUDED."windowIndex"
            THEN generation_rate_limit.count + 1 ELSE 1 END,
          "updatedAt" = NOW()
        RETURNING count
      `, [userId, windowIndex]);
      count = Number(result.rows[0].count);
    } catch {
      throw new HttpException('Rate limiter tidak tersedia.', 503);
    }

    if (++this.requests % 256 === 0) {
      void this.pool.query(`DELETE FROM generation_rate_limit WHERE "updatedAt" < NOW() - INTERVAL '1 day'`).catch(() => undefined);
    }
    if (count <= limit) return;
    response?.setHeader('Retry-After', String(seconds - now % seconds));
    throw new HttpException('Terlalu banyak permintaan generation. Coba lagi sebentar.', 429);
  }
}
