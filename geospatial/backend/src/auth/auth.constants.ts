export const USER_ROLES = ['admin', 'staff'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const APP_ACCESS = ['geospatial', 'planner'] as const;
export type AppAccess = (typeof APP_ACCESS)[number];

export function normalizeAppAccess(value: unknown): AppAccess[] {
  if (!Array.isArray(value)) return ['geospatial'];
  return APP_ACCESS.filter((app) => value.includes(app));
}

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLES_KEY = 'roles';
