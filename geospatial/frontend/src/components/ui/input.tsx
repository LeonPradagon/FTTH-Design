import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-xl border border-white/12 bg-black/10 px-3 py-2 text-sm text-[color:var(--foreground)] outline-none transition-colors placeholder:text-[color:var(--foreground-soft)] focus-visible:border-[color:var(--ring)] focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]/35',
        className,
      )}
      {...props}
    />
  )
}
