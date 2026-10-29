export type AppRole = 'admin' | 'staff'

export function roleMapPath(role: AppRole) {
  return `/${role}/map`
}
