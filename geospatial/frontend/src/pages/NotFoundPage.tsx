import { ArrowLeft, Home, MapPinned } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button'

export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <main className="min-h-[100dvh] bg-[#f8faf7] px-4 py-5 text-zinc-950 sm:px-6 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100dvh-2.5rem)] w-full max-w-[980px] flex-col justify-center">
        <div className="grid gap-8 rounded-[1.75rem] border border-zinc-200/80 bg-white/55 p-6 shadow-[0_24px_70px_-54px_rgba(24,24,27,0.85)] sm:p-8 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-end">
          <div className="space-y-8">
            <div className="flex items-center gap-3 text-sm font-semibold tracking-tight text-zinc-900">
              <span className="grid size-10 place-items-center rounded-2xl border border-zinc-200 bg-white text-emerald-800">
                <MapPinned className="size-5" strokeWidth={1.8} />
              </span>
              Surge Map Viewer
            </div>

            <div className="space-y-5">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">
                404
              </p>
              <h1 className="max-w-[12ch] text-4xl font-semibold leading-none tracking-tighter text-zinc-950 md:text-6xl">
                Page not found.
              </h1>
              <p className="max-w-[52ch] text-base leading-relaxed text-zinc-600">
                The requested path is not available in this workspace.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                type="button"
                className="h-11 rounded-2xl bg-zinc-950 px-5 text-sm font-semibold text-[#f8faf7] shadow-none hover:bg-zinc-800"
                onClick={() => navigate(-1)}
              >
                <ArrowLeft className="mr-2 size-4" strokeWidth={1.8} />
                Go back
              </Button>
              <Link
                to="/"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-zinc-200 bg-white px-5 text-sm font-semibold text-zinc-950 shadow-none transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Home className="mr-2 size-4" strokeWidth={1.8} />
                Home
              </Link>
            </div>
          </div>

          <div className="relative h-64 overflow-hidden rounded-[1.5rem] border border-zinc-200 bg-[#f4f6f1]">
            <div className="absolute left-6 right-8 top-14 h-px rotate-[-10deg] bg-zinc-300" />
            <div className="absolute left-9 right-6 top-32 h-px rotate-[18deg] bg-zinc-300" />
            <div className="absolute bottom-8 left-10 top-7 w-px rotate-[8deg] bg-zinc-300" />
            <div className="absolute left-[30%] top-[32%] size-2 rounded-full bg-emerald-700" />
            <div className="absolute left-[68%] top-[60%] size-2 rounded-full bg-zinc-400" />
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-zinc-200 bg-white/85 p-3 backdrop-blur">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-zinc-900">Unknown path</span>
                <span className="text-xs text-zinc-500">No route</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
