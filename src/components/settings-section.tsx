import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

export function SettingsSection({
  title,
  description,
  action,
  children,
  footer,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section className="flex flex-col lg:max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-base font-semibold tracking-tight">{title}</h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <Separator className="my-4" />
      <div className="space-y-5">{children}</div>
      {footer && <div className="mt-5">{footer}</div>}
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
  wide = false,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between',
        wide && 'sm:flex-col sm:items-stretch'
      )}
    >
      <div className={cn('space-y-0.5', !wide && 'sm:max-w-sm')}>
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className={cn(wide ? 'w-full' : 'shrink-0')}>{children}</div>
    </div>
  )
}
