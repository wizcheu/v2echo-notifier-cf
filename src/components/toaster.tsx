import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, X } from 'lucide-react'
import { useStore } from '@/lib/api'
import { cn } from '@/lib/utils'

export function Toaster() {
  const message = useStore((s) => s.message)
  const error = useStore((s) => s.error)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (!message || paused) return
    const timer = window.setTimeout(() => {
      if (useStore.getState().message === message) {
        useStore.setState({ message: '' })
      }
    }, 3600)
    return () => window.clearTimeout(timer)
  }, [message, paused])

  if (!message && !error) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:end-6 sm:bottom-6 sm:w-96"
    >
      {error && (
        <div
          role="alert"
          className={cn(
            'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-destructive/30 bg-popover p-3.5 text-popover-foreground shadow-lg',
            'animate-in fade-in-0 slide-in-from-bottom-2 duration-200'
          )}
        >
          <AlertCircle
            className="mt-0.5 size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">操作未完成</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {error}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => useStore.setState({ error: '' })}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {message && (
        <div
          role="status"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          className={cn(
            'pointer-events-auto flex w-full items-center gap-3 rounded-lg border bg-popover px-3.5 py-3 text-popover-foreground shadow-lg',
            'animate-in fade-in-0 slide-in-from-bottom-2 duration-200'
          )}
        >
          <CheckCircle2
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-sm font-medium">{message}</p>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => useStore.setState({ message: '' })}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
