const DEFAULTS = {
  betterAuthUrl: 'http://localhost:3000',
  corsOrigin: 'http://localhost:5173',
  databaseUrl: 'postgres://postgres:postgres@db:5432/geospatial_app',
  databasePoolMax: 10,
  graphHopperProfile: 'motor_scooter',
  graphHopperTimeoutMs: 15000,
  graphHopperUrl: 'http://graphhopper:8989',
  port: 3000,
  sessionTtlHours: 168,
} as const;

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function asNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number.`);
  }

  return parsed;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateEnvironment(config: Record<string, unknown>) {
  const initialAdminEmail = asOptionalString(config.INITIAL_ADMIN_EMAIL);
  const initialAdminPassword = asOptionalString(config.INITIAL_ADMIN_PASSWORD);
  const initialDesignerEmail = asOptionalString(config.INITIAL_DESIGNER_EMAIL);
  const initialDesignerPassword = asOptionalString(
    config.INITIAL_DESIGNER_PASSWORD,
  );

  if (
    (initialAdminEmail && !initialAdminPassword) ||
    (!initialAdminEmail && initialAdminPassword)
  ) {
    throw new Error(
      'INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must either both be set or both be omitted.',
    );
  }

  if (
    (initialDesignerEmail && !initialDesignerPassword) ||
    (!initialDesignerEmail && initialDesignerPassword)
  ) {
    throw new Error(
      'INITIAL_DESIGNER_EMAIL and INITIAL_DESIGNER_PASSWORD must either both be set or both be omitted.',
    );
  }

  return {
    NODE_ENV: asString(config.NODE_ENV, 'development'),
    PORT: asNumber(config.PORT, DEFAULTS.port, 'PORT'),
    BETTER_AUTH_URL: asString(config.BETTER_AUTH_URL, DEFAULTS.betterAuthUrl),
    CORS_ORIGIN: asString(config.CORS_ORIGIN, DEFAULTS.corsOrigin),
    DATABASE_URL: asString(config.DATABASE_URL, DEFAULTS.databaseUrl),
    DATABASE_POOL_MAX: asNumber(
      config.DATABASE_POOL_MAX,
      DEFAULTS.databasePoolMax,
      'DATABASE_POOL_MAX',
    ),
    GRAPHHOPPER_URL: asString(config.GRAPHHOPPER_URL, DEFAULTS.graphHopperUrl),
    GRAPHHOPPER_TIMEOUT_MS: asNumber(
      config.GRAPHHOPPER_TIMEOUT_MS,
      DEFAULTS.graphHopperTimeoutMs,
      'GRAPHHOPPER_TIMEOUT_MS',
    ),
    GRAPHHOPPER_PROFILE: asString(
      config.GRAPHHOPPER_PROFILE,
      DEFAULTS.graphHopperProfile,
    ),
    SESSION_TTL_HOURS: asNumber(
      config.SESSION_TTL_HOURS,
      DEFAULTS.sessionTtlHours,
      'SESSION_TTL_HOURS',
    ),
    INITIAL_ADMIN_EMAIL: initialAdminEmail,
    INITIAL_ADMIN_PASSWORD: initialAdminPassword,
    INITIAL_DESIGNER_EMAIL: initialDesignerEmail,
    INITIAL_DESIGNER_PASSWORD: initialDesignerPassword,
  };
}
