import type { LucideIcon } from 'lucide-react'
import { ArrowUpRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  href,
  tone = 'default',
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: LucideIcon
  href?: string
  tone?: 'default' | 'warning' | 'danger'
  className?: string
}) {
  const content = (
    <Card
      className={cn(
        'gap-2 py-4 transition-[border-color,background-color,box-shadow] duration-150',
        href && 'group hover:border-foreground/20 hover:bg-accent/25',
        className
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-5 pb-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <div className="flex items-center gap-1 text-muted-foreground">
          {Icon && <Icon className="size-4" aria-hidden="true" />}
          {href && (
            <ArrowUpRight
              className="size-3.5 -translate-x-0.5 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100"
              aria-hidden="true"
            />
          )}
        </div>
      </CardHeader>
      <CardContent className="px-5">
        <div
          className={cn(
            'text-2xl font-bold tracking-tight tabular-nums',
            tone === 'danger' && 'text-destructive',
            tone === 'warning' && 'text-amber-600 dark:text-amber-400'
          )}
        >
          {value}
        </div>
        {hint && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  )

  return href ? (
    <a href={`#${href}`} className="block rounded-xl focus-visible:outline-none">
      {content}
    </a>
  ) : (
    content
  )
}
