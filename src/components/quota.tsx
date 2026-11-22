import { ArrowRight, Play, RefreshCw } from 'lucide-react'
import { format, time, useStore } from '@/lib/api'
import { checkWindow } from '../../shared/check-schedule'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function ProgressBar({
  value,
  max,
  label,
  warning,
}: {
  value: number
  max: number
  label: string
  warning: boolean
}) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const visualWidth = value > 0 ? Math.max(percent, 2) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300',
          warning ? 'bg-destructive' : 'bg-primary'
        )}
        style={{ width: `${visualWidth}%` }}
      />
    </div>
  )
}

export function Quota() {
  const { data, busy, action } = useStore()
  const d = data!
  const s = d.notifier
  const todayKey = new Date(d.now).toISOString().slice(0, 10)
  const today = d.daily.find((x) => x.day === todayKey)
  const api = d.api_usage
  const attempts = api.daily
    .filter((x) => x.day === todayKey)
    .reduce((sum, x) => sum + x.attempts, 0)
  const budget = api.latest_budget

  const rows = [
    {
      label: 'Worker 调用',
      value: today?.invocations ?? 0,
      limit: d.limits.requests,
    },
    {
      label: 'D1 读取行',
      value: today?.rows_read ?? 0,
      limit: d.limits.rowsRead,
    },
    {
      label: 'D1 写入行',
      value: today?.rows_written ?? 0,
      limit: d.limits.rowsWritten,
    },
  ]

  const canRun = s.storage_ready && Boolean(s.binding_id) && !s.blocked

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map((row) => {
          const percent =
            row.limit > 0 ? Math.min(100, (row.value / row.limit) * 100) : 0
          return (
            <div
              key={row.label}
              className="flex flex-col gap-2 rounded-lg border bg-card p-3.5"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-muted-foreground">
                  {row.label}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {percent === 0
                    ? '0%'
                    : percent < 1
                      ? `${percent.toFixed(1)}%`
                      : `${Math.round(percent)}%`}
                </span>
              </div>
              <p className="text-base font-semibold tabular-nums">
                {format(row.value)}
                <span className="text-xs font-normal text-muted-foreground">
                  {' '}
                  / {format(row.limit)}
                </span>
              </p>
              <ProgressBar
                value={Math.min(row.value, row.limit)}
                max={row.limit}
                label={`${row.label}额度占比`}
                warning={percent >= 90}
              />
            </div>
          )
        })}
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">今日 V2EX API 请求</p>
          <p className="text-sm font-medium tabular-nums">
            {format(attempts)} 次
          </p>
        </div>
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">
            API 剩余配额
            {budget && (
              <span className="ms-1.5">
                （采样于 {time(budget.finished_at ?? budget.attempted_at)}）
              </span>
            )}
          </p>
          <p className="text-sm font-medium tabular-nums">
            {budget?.remaining == null ? '等待首次采样' : format(budget.remaining)}
            {budget?.budget_limit != null && (
              <span className="font-normal text-muted-foreground">
                {' '}
                / {format(budget.budget_limit)}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          disabled={
            busy || !s.enabled || !canRun || !checkWindow(d.now, s).open
          }
          onClick={() => void action('/notifier/tick', 'POST')}
        >
          <Play className="size-3.5" />
          立即执行检查
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={
            busy || !s.binding_id || !s.storage_ready || s.blocked === 'pairing'
          }
          onClick={() => void action('/notifier/watch/sync', 'POST')}
        >
          <RefreshCw className="size-3.5" />
          同步关注规则
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto text-muted-foreground"
          onClick={() => (window.location.hash = 'checks')}
        >
          查看检查日志
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
