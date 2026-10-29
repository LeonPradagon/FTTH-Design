import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CurrentSessionResponse, SessionRecord, SessionUser } from '../lib/api'
import { authClient } from '../lib/auth-client'

type AuthContextValue = {
  isAuthenticated: boolean
  isBootstrapping: boolean
  session: SessionRecord | null
  user: SessionUser | null
  login: (input: { email: string; password: string }) => Promise<SessionUser>
  logout: () => Promise<void>
  refreshSession: () => Promise<CurrentSessionResponse | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function normalizeSessionPayload(
  value: unknown,
): CurrentSessionResponse | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const payload = value as {
    session?: Record<string, unknown>
    user?: Record<string, unknown>
  }

  if (!payload.session || !payload.user) {
    return null
  }

  const user: SessionUser = {
    id: String(payload.user.id ?? ''),
    name: String(payload.user.name ?? ''),
    email: String(payload.user.email ?? ''),
    emailVerified: Boolean(payload.user.emailVerified),
    image:
      typeof payload.user.image === 'string' && payload.user.image.trim().length > 0
        ? payload.user.image
        : null,
    role: payload.user.role === 'admin' ? 'admin' : 'staff',
    appAccess: Array.isArray(payload.user.appAccess)
      ? payload.user.appAccess.filter((app): app is 'geospatial' | 'planner' => app === 'geospatial' || app === 'planner')
      : ['geospatial'],
    status: payload.user.status === 'disabled' ? 'disabled' : 'active',
    forcePasswordReset: Boolean(payload.user.forcePasswordReset),
    lastLoginAt:
      typeof payload.user.lastLoginAt === 'string' ? payload.user.lastLoginAt : null,
    createdByUserId:
      typeof payload.user.createdByUserId === 'string'
        ? payload.user.createdByUserId
        : null,
    createdAt: String(payload.user.createdAt ?? ''),
    updatedAt: String(payload.user.updatedAt ?? ''),
  }

  const session: SessionRecord = {
    id: String(payload.session.id ?? ''),
    userId: String(payload.session.userId ?? ''),
    token: typeof payload.session.token === 'string' ? payload.session.token : undefined,
    expiresAt: String(payload.session.expiresAt ?? ''),
    createdAt: String(payload.session.createdAt ?? ''),
    updatedAt: String(payload.session.updatedAt ?? ''),
  }

  return {
    user,
    session,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const sessionQuery = authClient.useSession()

  const normalizedSession = useMemo(
    () => normalizeSessionPayload(sessionQuery.data),
    [sessionQuery.data],
  )

  const refreshSession = useCallback(async () => {
    const result = await authClient.getSession()
    await sessionQuery.refetch()
    return normalizeSessionPayload(result.data)
  }, [sessionQuery])

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      const result = await authClient.signIn.email({
        email: input.email,
        password: input.password,
      })

      if (result.error) {
        throw new Error(result.error.message || 'Login failed.')
      }

      const nextSession =
        normalizeSessionPayload(result.data) ?? (await refreshSession())

      if (!nextSession) {
        throw new Error('Unable to load the session after login.')
      }

      return nextSession.user
    },
    [refreshSession],
  )

  const logout = useCallback(async () => {
    await authClient.signOut()
    queryClient.clear()
    await sessionQuery.refetch()
  }, [queryClient, sessionQuery])

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: Boolean(normalizedSession?.user && normalizedSession.session),
      isBootstrapping: sessionQuery.isPending,
      session: normalizedSession?.session ?? null,
      user: normalizedSession?.user ?? null,
      login,
      logout,
      refreshSession,
    }),
    [login, normalizedSession, refreshSession, sessionQuery.isPending, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider.')
  }

  return context
}
