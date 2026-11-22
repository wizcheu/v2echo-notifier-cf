import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'

export function PageHeader({
  title,
  description,
  actions,
  separator = false,
  large = false,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  separator?: boolean
  large?: boolean
  className?: string
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h1
            className={cn(
              'font-bold tracking-tight',
              large ? 'text-2xl md:text-3xl' : 'text-2xl'
            )}
          >
            {title}
          </h1>
          {description && (
            <p className="text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2">{actions}</div>
        )}
      </div>
      {separator && <Separator className="my-4 lg:my-6" />}
    </div>
  )
}
