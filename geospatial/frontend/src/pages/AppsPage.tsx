import { ArrowRight, Cable, LogOut, Radio } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { Button } from '../components/ui/button'
import { roleMapPath } from '../lib/routes'

const ftthUrl = import.meta.env.VITE_FTTH_URL?.trim() || '/ftth'

export function AppsPage() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  if (!user) return null

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#f4f6f3] px-5 py-10 text-zinc-950">
      <section className="w-full max-w-4xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-emerald-800">FTTH Workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Pilih aplikasi FTTH</h1>
            <p className="mt-2 text-zinc-600">Halo, {user.name || user.email}. Pilih workspace yang ingin Anda buka.</p>
          </div>
          <Button variant="outline" onClick={() => void logout()}>
            <LogOut />
            Keluar
          </Button>
        </header>

        <div className={`grid gap-5 ${user.appAccess.length > 1 ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
          {user.appAccess.includes('geospatial') && (
          <article className="flex min-h-64 flex-col rounded-3xl border border-zinc-200 bg-white p-7 shadow-sm">
            <span className="mb-5 grid size-12 place-items-center rounded-2xl bg-emerald-50 text-emerald-800">
              <Radio className="size-6" />
            </span>
            <h2 className="text-xl font-semibold">FTTH Geospatial</h2>
            <p className="mt-2 flex-1 text-sm leading-6 text-zinc-600">Buka workspace Geospatial untuk melihat dan mengelola peta serta data jaringan FTTH.</p>
            <Button className="mt-6 w-full" onClick={() => navigate(roleMapPath(user.role))}>
              Buka FTTH Geospatial <ArrowRight />
            </Button>
          </article>
          )}

          {user.appAccess.includes('planner') && (
          <article className="flex min-h-64 flex-col rounded-3xl border border-zinc-200 bg-white p-7 shadow-sm">
            <span className="mb-5 grid size-12 place-items-center rounded-2xl bg-blue-50 text-blue-700">
              <Cable className="size-6" />
            </span>
            <h2 className="text-xl font-semibold">FTTH Planner</h2>
            <p className="mt-2 flex-1 text-sm leading-6 text-zinc-600">Buat rancangan jaringan FTTH, generate kabel, dan hitung homepass.</p>
            <Button variant="outline" className="mt-6 w-full" onClick={() => window.location.assign(ftthUrl)}>
              Buka FTTH Planner <ArrowRight />
            </Button>
          </article>
          )}

          {user.appAccess.length === 0 && (
            <p className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              Akun ini belum memiliki akses ke aplikasi. Hubungi administrator.
            </p>
          )}
        </div>
      </section>
    </main>
  )
}
