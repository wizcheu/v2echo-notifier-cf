import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 py-14 text-center',
        className
      )}
    >
      {icon && (
        <div className="mb-1 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <p className="max-w-md text-sm text-muted-foreground">{children}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
