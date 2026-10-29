import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  KeyRound,
  LogOut,
  MapPinned,
  Menu,
  MousePointer2,
  Pentagon,
  Plus,
  Ruler,
  Route,
  Trash2,
  UserRound,
} from 'lucide-react'
import { type FormEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '../../auth/auth-context'
import { cn } from '../../lib/utils'
import {
  changeMyPassword,
  createUser,
  deleteUser as deleteUserRequest,
  fetchUsers,
  resetUserPassword,
  updateUserAppAccess,
  type AppAccess,
  type UserRole,
} from '../../lib/api'
import { Button } from '../ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog'
import { Input } from '../ui/input'
import type { AppNavbarProps } from './types'

const DRAW_TOOLS = [
  { id: 'pan', icon: MousePointer2, label: 'Cursor', shortcut: 'Q' },
  { id: 'placemark', icon: MapPinned, label: 'Add node', shortcut: 'W' },
  { id: 'polygon', icon: Pentagon, label: 'Add polygon', shortcut: 'E' },
  { id: 'line', icon: Route, label: 'Add polyline', shortcut: 'R' },
  { id: 'measure', icon: Ruler, label: 'Measure route', shortcut: 'M' },
] as const

function generateTemporaryPassword() {
  const bytes = new Uint32Array(2)
  window.crypto.getRandomValues(bytes)
  return `Geo-${bytes[0].toString(36)}-${bytes[1].toString(36)}!`
}

function roleLabel(role: UserRole) {
  return role === 'admin' ? 'Admin' : 'Staff'
}

export function AppNavbar({
  activeTool,
  currentUser,
  onSignOut,
  onClear,
  onToggleSidebar,
  onToolSelect,
}: AppNavbarProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { refreshSession } = useAuth()
  const [accountOpen, setAccountOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newOwnPassword, setNewOwnPassword] = useState('')
  const [createEmail, setCreateEmail] = useState('')
  const [createRole, setCreateRole] = useState<UserRole>('staff')
  const [createAppAccess, setCreateAppAccess] = useState<AppAccess[]>(['geospatial'])
  const [createPassword, setCreatePassword] = useState(generateTemporaryPassword)
  const [resetUserId, setResetUserId] = useState('')
  const [accessUserId, setAccessUserId] = useState('')
  const [accessLevel, setAccessLevel] = useState<'geospatial' | 'planner' | 'both'>('geospatial')
  const [resetPassword, setResetPassword] = useState(generateTemporaryPassword)
  const [deleteUserId, setDeleteUserId] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const displayEmail = currentUser?.email?.trim() || 'Signed in'
  const isAdmin = currentUser?.role === 'admin'

  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: fetchUsers,
    enabled: accountOpen && isAdmin,
  })

  const users = usersQuery.data ?? []
  const deletableUsers = useMemo(
    () => users.filter((user) => user.id !== currentUser?.id),
    [currentUser?.id, users],
  )
  const resetTarget = useMemo(
    () => users.find((user) => user.id === resetUserId) ?? users[0] ?? null,
    [resetUserId, users],
  )
  const deleteTarget = useMemo(
    () =>
      deletableUsers.find((user) => user.id === deleteUserId) ??
      deletableUsers[0] ??
      null,
    [deleteUserId, deletableUsers],
  )

  const createUserMutation = useMutation({
    mutationFn: () =>
      createUser({
        email: createEmail,
        password: createPassword,
        role: createRole,
        appAccess: createAppAccess,
      }),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setCreateEmail('')
      setCreateRole('staff')
      setCreateAppAccess(['geospatial'])
      setCreatePassword(generateTemporaryPassword())
      toast.success('User created', {
        description: user.email,
      })
    },
    onError: (error) => {
      toast.error('Unable to create user', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    },
  })

  const appAccessMutation = useMutation({
    mutationFn: () => updateUserAppAccess(
      accessUserId,
      accessLevel === 'both' ? ['geospatial', 'planner'] : [accessLevel],
    ),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      await refreshSession()
      toast.success('Application access updated', { description: user.email })
    },
    onError: (error) => {
      toast.error('Unable to update access', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    },
  })

  const changePasswordMutation = useMutation({
    mutationFn: () =>
      changeMyPassword({
        currentPassword,
        newPassword: newOwnPassword,
        revokeOtherSessions: true,
      }),
    onSuccess: async () => {
      setCurrentPassword('')
      setNewOwnPassword('')
      await refreshSession()
      toast.success('Password updated')
    },
    onError: (error) => {
      toast.error('Unable to change password', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: () => resetUserPassword(resetTarget!.id, resetPassword),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setResetPassword(generateTemporaryPassword())
      toast.success('Temporary password set', {
        description: user.email,
      })
    },
    onError: (error) => {
      toast.error('Unable to reset password', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: () => deleteUserRequest(deleteTarget!.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setDeleteUserId('')
      setDeleteConfirmOpen(false)
      toast.success('User deleted', {
        description: result.deletedEmail,
      })
    },
    onError: (error) => {
      toast.error('Unable to delete user', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    },
  })

  function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!createEmail.trim() || createPassword.length < 8) {
      return
    }

    createUserMutation.mutate()
  }

  function handleChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (currentPassword.length < 8 || newOwnPassword.length < 8) {
      return
    }

    changePasswordMutation.mutate()
  }

  function handleResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!resetTarget || resetPassword.length < 8) {
      return
    }

    resetPasswordMutation.mutate()
  }

  function handleDeleteUser() {
    if (!deleteTarget) {
      return
    }

    deleteUserMutation.mutate()
  }

  return (
    <header className="border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="flex min-h-16 items-center gap-3 px-3 sm:px-5">
        <div className="flex items-center gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-xl text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
          >
            <Menu className="size-4" />
          </Button>

          <div className="mx-1 h-6 w-px bg-slate-200" />

          {DRAW_TOOLS.map((tool) => (
            <Button
              key={tool.id}
              variant="ghost"
              size="icon"
              className={cn(
                'rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900',
                activeTool === tool.id &&
                  'bg-sky-50 text-sky-700 ring-1 ring-sky-100 hover:bg-sky-50 hover:text-sky-700',
              )}
              onClick={() => onToolSelect(tool.id)}
              aria-label={`${tool.label} (${tool.shortcut})`}
              title={`${tool.label} (${tool.shortcut})`}
            >
              <tool.icon className="size-4" />
            </Button>
          ))}

          <div className="mx-1 h-6 w-px bg-slate-200" />

          <Button
            variant="ghost"
            size="icon"
            className="rounded-xl text-slate-500 hover:bg-rose-50 hover:text-rose-600"
            onClick={onClear}
            aria-label="Clear drawings"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          {isAdmin && (
            <Button
              variant="outline"
              className="h-10 rounded-xl border-slate-200 bg-white px-3 text-slate-700 shadow-sm hover:bg-slate-50"
              onClick={() => navigate('/apps')}
            >
              <ArrowLeft className="size-4" />
              <span className="hidden sm:inline">Pilih aplikasi</span>
            </Button>
          )}
          <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-left text-slate-700 shadow-sm hover:bg-slate-50"
                  aria-label="Open account center"
                />
              }
            >
              <UserRound className="size-4 text-slate-500" />
              <span className="hidden min-w-0 sm:block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Account
                </span>
                <span className="block max-w-52 truncate text-sm font-medium text-slate-700">
                  {displayEmail}
                </span>
              </span>
            </DialogTrigger>

            <DialogContent
              className={cn(
                'grid max-h-[min(760px,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_24px_80px_rgba(15,23,42,0.14)]',
                isAdmin ? 'sm:max-w-5xl' : 'sm:max-w-xl',
              )}
            >
              <DialogHeader className="border-b border-slate-200 px-6 pb-5 pt-6">
                <DialogTitle className="text-xl font-semibold text-slate-900">
                  Account Center
                </DialogTitle>
                <DialogDescription className="text-sm text-slate-500">
                  {isAdmin
                    ? 'Manage password access and admin-created user accounts.'
                    : 'Manage your account details and password access.'}
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
                <div
                  className={cn(
                    'grid gap-5',
                    isAdmin ? 'lg:grid-cols-[360px_1fr]' : 'mx-auto w-full max-w-md',
                  )}
                >
                  <section className="rounded-2xl border border-slate-200 bg-white p-5">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-slate-900">
                        {currentUser?.name || displayEmail}
                      </p>
                      <p className="truncate text-sm text-slate-500">{displayEmail}</p>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                        {roleLabel(currentUser?.role ?? 'staff')}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold capitalize text-slate-700">
                        {currentUser?.status ?? 'active'}
                      </span>
                      {currentUser?.forcePasswordReset ? (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800">
                          Password reset required
                        </span>
                      ) : null}
                    </div>

                    <form onSubmit={handleChangePassword} className="mt-5 border-t border-slate-100 pt-5">
                      <p className="text-sm font-semibold text-slate-900">Change password</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {currentUser?.forcePasswordReset
                          ? 'Temporary password active. Set a new password.'
                          : 'Update your own password.'}
                      </p>

                      <label className="mt-4 grid gap-1.5">
                        <span className="text-xs font-semibold text-slate-500">Current password</span>
                        <Input
                          type="password"
                          value={currentPassword}
                          onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                          className="h-10 rounded-xl border-slate-200 bg-slate-50"
                          autoComplete="current-password"
                          minLength={8}
                          required
                        />
                      </label>
                      <label className="mt-3 grid gap-1.5">
                        <span className="text-xs font-semibold text-slate-500">New password</span>
                        <Input
                          type="password"
                          value={newOwnPassword}
                          onChange={(event) => setNewOwnPassword(event.currentTarget.value)}
                          className="h-10 rounded-xl border-slate-200 bg-slate-50"
                          autoComplete="new-password"
                          minLength={8}
                          required
                        />
                      </label>

                      <Button
                        type="submit"
                        className="mt-4 h-10 rounded-xl bg-slate-950 px-4 text-white hover:bg-slate-800"
                        disabled={changePasswordMutation.isPending}
                      >
                        <KeyRound className="size-4" />
                        {changePasswordMutation.isPending ? 'Updating' : 'Update password'}
                      </Button>
                    </form>
                  </section>

                  {isAdmin ? (
                    <section className="rounded-2xl border border-slate-200 bg-white p-5">
                      <form onSubmit={handleCreateUser}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">Create user</p>
                            <p className="mt-1 text-sm text-slate-500">
                              Add staff or admin accounts with a temporary password.
                            </p>
                          </div>
                          <Plus className="size-5 text-slate-400" />
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_130px]">
                          <label className="grid gap-1.5">
                            <span className="text-xs font-semibold text-slate-500">Email</span>
                            <Input
                              type="email"
                              value={createEmail}
                              onChange={(event) => setCreateEmail(event.currentTarget.value)}
                              placeholder="staff@example.com"
                              className="h-10 rounded-xl border-slate-200 bg-slate-50"
                              required
                            />
                          </label>
                          <label className="grid gap-1.5">
                            <span className="text-xs font-semibold text-slate-500">Role</span>
                            <select
                              value={createRole}
                              onChange={(event) => setCreateRole(event.currentTarget.value as UserRole)}
                              className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                            >
                              <option value="staff">Staff</option>
                              <option value="admin">Admin</option>
                            </select>
                          </label>
                        </div>

                        <label className="mt-3 grid gap-1.5">
                          <span className="text-xs font-semibold text-slate-500">Temporary password</span>
                          <div className="flex gap-2">
                            <Input
                              value={createPassword}
                              onChange={(event) => setCreatePassword(event.currentTarget.value)}
                              className="h-10 rounded-xl border-slate-200 bg-slate-50 font-mono text-sm"
                              minLength={8}
                              required
                            />
                            <Button
                              type="button"
                              variant="outline"
                              className="h-10 rounded-xl border-slate-200 bg-white px-3"
                              onClick={() => setCreatePassword(generateTemporaryPassword())}
                            >
                              Generate
                            </Button>
                          </div>
                        </label>

                        <label className="mt-3 grid gap-1.5">
                          <span className="text-xs font-semibold text-slate-500">Application access</span>
                          <select
                            value={createAppAccess.length === 2 ? 'both' : createAppAccess[0]}
                            onChange={(event) => setCreateAppAccess(
                              event.currentTarget.value === 'both'
                                ? ['geospatial', 'planner']
                                : [event.currentTarget.value as AppAccess],
                            )}
                            className="h-10 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-800"
                          >
                            <option value="geospatial">Geospatial only</option>
                            <option value="planner">Planner only</option>
                            <option value="both">Geospatial and Planner</option>
                          </select>
                        </label>

                        <Button
                          type="submit"
                          className="mt-4 h-10 rounded-xl bg-slate-950 px-4 text-white hover:bg-slate-800"
                          disabled={createUserMutation.isPending}
                        >
                          <Plus className="size-4" />
                          {createUserMutation.isPending ? 'Creating' : 'Create account'}
                        </Button>
                      </form>

                      <div className="mt-5 border-t border-slate-100 pt-4">
                        <p className="text-sm font-semibold text-slate-900">Manage application access</p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                          <select
                            value={accessUserId || currentUser?.id || users[0]?.id || ''}
                            onChange={(event) => setAccessUserId(event.currentTarget.value)}
                            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800"
                          >
                            {users.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
                          </select>
                          <select
                            value={accessLevel}
                            onChange={(event) => setAccessLevel(event.currentTarget.value as typeof accessLevel)}
                            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800"
                          >
                            <option value="geospatial">Geospatial only</option>
                            <option value="planner">Planner only</option>
                            <option value="both">Geospatial and Planner</option>
                          </select>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 rounded-xl"
                            disabled={!users.length || appAccessMutation.isPending}
                            onClick={() => appAccessMutation.mutate()}
                          >
                            Save access
                          </Button>
                        </div>
                      </div>

                      <details className="mt-5 border-t border-slate-100 pt-4">
                        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                          Need to reset another user's password?
                        </summary>
                        <form onSubmit={handleResetPassword} className="mt-4 rounded-2xl bg-slate-50 p-4">
                          <p className="text-sm text-slate-500">
                            Use this when a user cannot sign in. It creates a new temporary password and marks the account for password change.
                          </p>

                          <div className="mt-4 grid gap-3 xl:grid-cols-[1fr_1fr]">
                            <label className="grid gap-1.5">
                              <span className="text-xs font-semibold text-slate-500">
                                User {usersQuery.isLoading ? '(loading...)' : ''}
                              </span>
                              <select
                                value={resetTarget?.id ?? ''}
                                onChange={(event) => setResetUserId(event.currentTarget.value)}
                                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                                disabled={users.length === 0}
                              >
                                {users.length === 0 ? (
                                  <option value="">
                                    {usersQuery.isError ? 'Unable to load users' : 'No users'}
                                  </option>
                                ) : (
                                  users.map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.email}
                                    </option>
                                  ))
                                )}
                              </select>
                            </label>

                            <label className="grid gap-1.5">
                              <span className="text-xs font-semibold text-slate-500">
                                New temporary password
                              </span>
                              <div className="flex gap-2">
                                <Input
                                  value={resetPassword}
                                  onChange={(event) => setResetPassword(event.currentTarget.value)}
                                  className="h-10 rounded-xl border-slate-200 bg-white font-mono text-sm"
                                  minLength={8}
                                  required
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-10 rounded-xl border-slate-200 bg-white px-3"
                                  onClick={() => setResetPassword(generateTemporaryPassword())}
                                >
                                  Generate
                                </Button>
                              </div>
                            </label>
                          </div>

	                          <Button
	                            type="submit"
	                            className="mt-4 h-10 rounded-xl bg-slate-800 px-4 text-white hover:bg-slate-700"
	                            disabled={!resetTarget || resetPasswordMutation.isPending}
	                          >
	                            <KeyRound className="size-4" />
	                            {resetPasswordMutation.isPending ? 'Resetting' : 'Reset password'}
	                          </Button>
	                        </form>

	                        <div className="mt-4 rounded-2xl border border-rose-100 bg-white p-4">
	                          <p className="text-sm font-semibold text-rose-800">Delete user</p>
	                          <p className="mt-1 text-sm text-slate-500">
	                            Removes the account and active sessions. This cannot be undone.
	                          </p>

	                          <div className="mt-4 grid gap-3 xl:grid-cols-[1fr_auto]">
	                            <label className="grid gap-1.5">
	                              <span className="text-xs font-semibold text-slate-500">User</span>
	                              <select
	                                value={deleteTarget?.id ?? ''}
	                                onChange={(event) => setDeleteUserId(event.currentTarget.value)}
	                                className="h-10 rounded-xl border border-rose-100 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-rose-300 focus:ring-2 focus:ring-rose-100"
	                                disabled={deletableUsers.length === 0}
	                              >
	                                {deletableUsers.length === 0 ? (
	                                  <option value="">No deletable users</option>
	                                ) : (
	                                  deletableUsers.map((user) => (
	                                    <option key={user.id} value={user.id}>
	                                      {user.email}
	                                    </option>
	                                  ))
	                                )}
	                              </select>
	                            </label>

	                            <AlertDialog
	                              open={deleteConfirmOpen}
	                              onOpenChange={setDeleteConfirmOpen}
	                            >
	                              <AlertDialogTrigger
	                                render={
	                                  <Button
	                                    type="button"
	                                    variant="destructive"
	                                    className="h-10 self-end rounded-xl px-4"
	                                    disabled={!deleteTarget || deleteUserMutation.isPending}
	                                  />
	                                }
	                              >
	                                <Trash2 className="size-4" />
	                                {deleteUserMutation.isPending ? 'Deleting' : 'Delete user'}
	                              </AlertDialogTrigger>

	                              <AlertDialogContent className="overflow-hidden rounded-3xl border border-rose-100 bg-white p-0 shadow-[0_24px_80px_rgba(127,29,29,0.16)]">
	                                <AlertDialogHeader className="px-6 pb-5 pt-6">
	                                  <AlertDialogTitle className="text-lg font-semibold text-slate-900">
	                                    Delete user?
	                                  </AlertDialogTitle>
	                                  <AlertDialogDescription className="text-sm leading-6 text-slate-500">
	                                    {deleteTarget
	                                      ? `${deleteTarget.email} will lose access immediately. This removes the account and active sessions.`
	                                      : 'This removes the selected account and active sessions.'}
	                                  </AlertDialogDescription>
	                                </AlertDialogHeader>

	                                <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-white px-6 pb-6 pt-0">
	                                  <AlertDialogCancel className="h-10 rounded-xl border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-100">
	                                    Cancel
	                                  </AlertDialogCancel>
	                                  <AlertDialogAction
	                                    className="h-10 rounded-xl bg-rose-600 px-4 text-white hover:bg-rose-700"
	                                    onClick={handleDeleteUser}
	                                  >
	                                    Delete user
	                                  </AlertDialogAction>
	                                </AlertDialogFooter>
	                              </AlertDialogContent>
	                            </AlertDialog>
	                          </div>
	                        </div>
	                      </details>
                    </section>
                  ) : null}
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost"
                  className="hidden h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 shadow-none hover:bg-rose-50 hover:text-rose-600 lg:inline-flex"
                  aria-label="Sign out"
                  title="Sign out"
                />
              }
            >
              <LogOut className="size-4" />
              Sign out
            </AlertDialogTrigger>

            <AlertDialogContent className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 shadow-[0_24px_80px_rgba(15,23,42,0.14)]">
              <AlertDialogHeader className="px-6 pb-5 pt-6">
                <AlertDialogTitle className="text-lg font-semibold text-slate-900">
                  Sign out?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-sm leading-6 text-slate-500">
                  Your current session will end and you will return to the login screen.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-white px-6 pb-6 pt-0">
                <AlertDialogCancel className="h-10 rounded-xl border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-100">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="h-10 rounded-xl bg-rose-600 px-4 text-white hover:bg-rose-700"
                  onClick={onSignOut}
                >
                  Sign out
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </header>
  )
}
