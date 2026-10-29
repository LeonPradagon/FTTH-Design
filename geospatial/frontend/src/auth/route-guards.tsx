import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from './auth-context'
import { roleMapPath, type AppRole } from '../lib/routes'
import { Loader2 } from 'lucide-react'
import { Button } from '../components/ui/button'

export function FullscreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
    </div>
  )
}

export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isBootstrapping } = useAuth()

  if (isBootstrapping) return <FullscreenLoader />

  if (isAuthenticated) {
    return <Navigate replace to="/apps" />
  }

  return <>{children}</>
}

export function AuthenticatedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isBootstrapping } = useAuth()

  if (isBootstrapping) return <FullscreenLoader />
  if (!isAuthenticated) {
    return <Navigate replace to="/login" />
  }

  return <>{children}</>
}

export function RoleProtectedRoute({
  children,
  role,
}: {
  children: ReactNode
  role: AppRole
}) {
  const { isAuthenticated, isBootstrapping, user } = useAuth()

  if (isBootstrapping) {
    return <FullscreenLoader />
  }

  if (!isAuthenticated || !user) {
    return <Navigate replace to="/login" />
  }

  if (user.role !== role) {
    return <Navigate replace to={roleMapPath(user.role)} />
  }

  if (!user.appAccess.includes('geospatial')) {
    return <Navigate replace to="/apps" />
  }

  return <>{children}</>
}

export function SessionExpiredState() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="max-w-md w-full rounded-xl bg-white p-8 text-center shadow-sm border border-slate-200">
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Session unavailable</h2>
        <p className="text-slate-500 mb-6">Your session is no longer available. Please sign in again.</p>
        <Button onClick={() => window.location.href = '/login'} className="w-full">
          Go to login
        </Button>
      </div>
    </div>
  )
}
