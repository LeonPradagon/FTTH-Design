import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../auth/auth-context'
import { Eye, EyeOff, Lock, LogIn, Mail, MapPinned, ShieldCheck } from 'lucide-react'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'

export function LoginPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isPasswordVisible, setIsPasswordVisible] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      await login({ email, password })
      navigate('/apps', { replace: true })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-[100dvh] bg-[#f8faf7] text-zinc-950">
      <section className="mx-auto grid min-h-[100dvh] w-full max-w-[1180px] grid-cols-1 gap-8 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center lg:px-8">
        <div className="order-2 flex flex-col gap-12 rounded-[1.75rem] border border-zinc-200/80 bg-white/45 p-6 sm:p-8 lg:order-1">
          <div className="flex items-center gap-3 text-sm font-semibold tracking-tight text-zinc-900">
            <span className="grid size-10 place-items-center rounded-2xl border border-zinc-200 bg-white text-emerald-800">
              <MapPinned className="size-5" strokeWidth={1.8} />
            </span>
            Surge Map Viewer
          </div>

          <div className="grid gap-10 xl:grid-cols-[1fr_320px] xl:items-end">
            <div className="space-y-6">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Field intelligence</p>
              <h1 className="max-w-[13ch] text-4xl font-semibold leading-none tracking-tighter text-zinc-950 md:text-6xl">
                Read the site before the shift starts.
              </h1>
              <p className="max-w-[56ch] text-base leading-relaxed text-zinc-600">
                Inspect deck overlays, terrain risk, and access layers from the same protected map workspace.
              </p>

              <div className="grid max-w-md gap-4 border-t border-zinc-200 pt-6 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Map state</p>
                  <p className="mt-2 text-sm font-semibold text-zinc-950">Layer review</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Access</p>
                  <p className="mt-2 text-sm font-semibold text-zinc-950">Role based</p>
                </div>
              </div>
            </div>

            <div className="rounded-[1.5rem] border border-zinc-200 bg-white p-4">
              <div className="mb-4 flex items-center justify-between text-xs font-medium text-zinc-500">
                <span>Live layers</span>
                <span className="inline-flex items-center gap-2 text-emerald-800">
                  <span className="size-1.5 rounded-full bg-emerald-700" />
                  Available
                </span>
              </div>
              <div className="relative h-56 overflow-hidden rounded-[1.25rem] border border-zinc-200 bg-[#f4f6f1]">
                <div className="absolute left-5 right-8 top-14 h-px rotate-[-12deg] bg-zinc-300" />
                <div className="absolute left-10 right-5 top-32 h-px rotate-[18deg] bg-zinc-300" />
                <div className="absolute bottom-8 left-8 top-6 w-px rotate-[8deg] bg-zinc-300" />
                <div className="absolute left-[28%] top-[34%] size-2 rounded-full bg-emerald-700" />
                <div className="absolute left-[68%] top-[60%] size-2 rounded-full bg-emerald-700" />
                <div className="absolute bottom-4 left-4 right-4 rounded-2xl border border-zinc-200 bg-white/85 p-3 backdrop-blur">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold text-zinc-900">Hydrology overlay</span>
                    <span className="text-xs text-zinc-500">Updated now</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="order-1 flex items-center lg:order-2 lg:justify-end">
          <div className="w-full max-w-[420px] rounded-[1.75rem] border border-zinc-200 bg-white p-5 shadow-[0_24px_60px_-48px_rgba(24,24,27,0.85)] sm:p-7">
            <div className="mb-8 flex items-start justify-between gap-5">
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-800">Access</p>
                <h2 className="text-3xl font-semibold tracking-tighter text-zinc-950">Sign in</h2>
                <p className="text-sm leading-6 text-zinc-600">Use your workspace credentials to open the protected map.</p>
              </div>
              <div className="grid size-11 shrink-0 place-items-center rounded-2xl border border-zinc-200 bg-[#f4f8ef] text-emerald-900">
                <ShieldCheck className="size-5" strokeWidth={1.8} />
              </div>
            </div>

            {errorMessage ? (
              <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium leading-6 text-red-700">
                {errorMessage}
              </div>
            ) : null}

            <form className="space-y-6" onSubmit={(e) => void handleSubmit(e)}>
              <div className="space-y-5">
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-zinc-950" htmlFor="email">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" strokeWidth={1.8} />
                    <Input
                      id="email"
                      type="email"
                      required
                      autoComplete="username"
                      placeholder="name@company.com"
                      aria-invalid={Boolean(errorMessage)}
                      className="h-12 rounded-2xl border-zinc-200 bg-white pl-10 text-zinc-950 placeholder:text-zinc-400 focus-visible:border-emerald-700 focus-visible:ring-emerald-700/15"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-semibold text-zinc-950" htmlFor="password">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" strokeWidth={1.8} />
                    <Input
                      id="password"
                      type={isPasswordVisible ? 'text' : 'password'}
                      required
                      autoComplete="current-password"
                      placeholder="Password"
                      aria-invalid={Boolean(errorMessage)}
                      className="h-12 rounded-2xl border-zinc-200 bg-white pl-10 pr-12 text-zinc-950 placeholder:text-zinc-400 focus-visible:border-emerald-700 focus-visible:ring-emerald-700/15"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700/20"
                      aria-label={isPasswordVisible ? 'Hide password' : 'Show password'}
                      aria-pressed={isPasswordVisible}
                      onClick={() => setIsPasswordVisible((current) => !current)}
                    >
                      {isPasswordVisible ? (
                        <EyeOff className="size-4" strokeWidth={1.8} />
                      ) : (
                        <Eye className="size-4" strokeWidth={1.8} />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                size="lg"
                className="h-12 w-full rounded-2xl bg-zinc-950 text-sm font-semibold text-[#f8faf7] shadow-none transition-transform hover:bg-zinc-800 active:scale-[0.98]"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <span className="mr-2 flex items-center gap-1">
                      <span className="size-1.5 animate-pulse rounded-full bg-[#f8faf7]/55" />
                      <span className="size-1.5 animate-pulse rounded-full bg-[#f8faf7]/70 [animation-delay:120ms]" />
                      <span className="size-1.5 animate-pulse rounded-full bg-[#f8faf7]/90 [animation-delay:240ms]" />
                    </span>
                    Checking access
                  </>
                ) : (
                  <>
                    <LogIn className="mr-2 size-4" strokeWidth={1.8} />
                    Sign in
                  </>
                )}
              </Button>
            </form>
          </div>
        </aside>
      </section>
    </main>
  )
}
