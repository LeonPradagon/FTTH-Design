import { Navigate, Route, Routes } from 'react-router-dom'
import App from './App'
import {
  AuthenticatedRoute,
  FullscreenLoader,
  PublicOnlyRoute,
  RoleProtectedRoute,
} from './auth/route-guards'
import { useAuth } from './auth/auth-context'
import { AppsPage } from './pages/AppsPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'

function HomeRedirect() {
  const { isAuthenticated, isBootstrapping } = useAuth()

  if (isBootstrapping) return <FullscreenLoader />

  if (isAuthenticated) {
    return <Navigate replace to="/apps" />
  }

  return <Navigate replace to="/login" />
}

export default function RootApp() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/apps"
        element={
          <AuthenticatedRoute>
            <AppsPage />
          </AuthenticatedRoute>
        }
      />
      <Route
        path="/admin/map"
        element={
          <RoleProtectedRoute role="admin">
            <App />
          </RoleProtectedRoute>
        }
      />
      <Route
        path="/staff/map"
        element={
          <RoleProtectedRoute role="staff">
            <App />
          </RoleProtectedRoute>
        }
      />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
