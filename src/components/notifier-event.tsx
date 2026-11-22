import { useEffect, useState } from 'react'
import { Bell, ChevronRight, FlaskConical, Star } from 'lucide-react'
import { request, time, useStore } from '@/lib/api'
import { shortTime } from '@/lib/format'
import type { NotificationRecord } from '../../shared/contracts'
import {
  eventLabel,
  eventSourceLabel,
  eventStatusMeta,
} from './notifier-labels'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { TableCell, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export function EventTypeIcon({
  type,
  className = 'size-4',
}: {
  type: NotificationRecord['type']
  className?: string
}) {
  if (type === 'test')
    return <FlaskConical className={className} aria-hidden="true" />
  if (type === 'watch_update')
    return <Star className={className} aria-hidden="true" />
  return <Bell className={className} aria-hidden="true" />
}

export function EventDetailDialog({
  event,
  open,
  onOpenChange,
}: {
  event: NotificationRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const requestVersion = useStore((s) => s.requestVersion)
  const [retryCount, setRetryCount] = useState(0)
  const [loaded, setLoaded] = useState<{
    key: string
    content?: { title: string; body: string }
    error?: string
  } | null>(null)

  const eventId = open && event ? event.event_id : null
  const fetchKey = eventId ? `${requestVersion}:${eventId}:${retryCount}` : null

  useEffect(() => {
    if (!eventId || !fetchKey) return
    let cancelled = false
    void request<{ title: string; body: string }>(
      requestVersion,
      `/notifier/events/${eventId}`
    ).then(
      (content) => {
        if (!cancelled) setLoaded({ key: fetchKey, content })
      },
      (e) => {
        if (!cancelled) {
          setLoaded({
            key: fetchKey,
            error: e instanceof Error ? e.message : '读取内容失败',
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [requestVersion, eventId, fetchKey])

  if (!event) return null
  const label = eventLabel(event)
  const status = eventStatusMeta(event)
  const loading = Boolean(fetchKey && loaded?.key !== fetchKey)
  const content = loaded?.key === fetchKey ? loaded.content : undefined
  const error = loaded?.key === fetchKey ? loaded.error : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pe-6">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{label}</span>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </DialogTitle>
          <DialogDescription>
            {eventSourceLabel(event)} · 更新于 {time(event.updated_at)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {loading ? (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3.5">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <AlertTitle>通知内容读取失败</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {error}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRetryCount((n) => n + 1)}
                >
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            content && (
              <div className="rounded-lg border bg-muted/30 p-3.5">
                <p className="font-medium text-foreground">{content.title}</p>
                {content.body && (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {content.body}
                  </p>
                )}
              </div>
            )
          )}
          {event.detail && (
            <p className="text-xs text-muted-foreground">{event.detail}</p>
          )}
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">投递次数</dt>
            <dd className="tabular-nums">
              发送 {event.attempts} 次 · 回执查询 {event.receipt_attempts} 次
            </dd>
            {event.notification_id && (
              <>
                <dt className="text-muted-foreground">关联编号</dt>
                <dd className="tabular-nums">
                  {event.type === 'test' ? '真实样本' : '通知'} #
                  {event.notification_id}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">入队时间</dt>
            <dd className="tabular-nums">{time(event.created_at)}</dd>
            <dt className="text-muted-foreground">有效期至</dt>
            <dd className="tabular-nums">{time(event.expires_at)}</dd>
            {['pending', 'submitted'].includes(event.status) && (
              <>
                <dt className="text-muted-foreground">下次重试</dt>
                <dd className="tabular-nums">{time(event.next_at)}</dd>
              </>
            )}
          </dl>
          {event.status === 'apns_accepted' && (
            <p className="text-xs text-muted-foreground">
              APNs 已接收表示 Apple 推送服务已收件，不代表设备已显示或已读。
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function EventRow({
  event,
  onSelect,
}: {
  event: NotificationRecord
  onSelect: (event: NotificationRecord) => void
}) {
  const label = eventLabel(event)
  const source = eventSourceLabel(event)
  const status = eventStatusMeta(event)

  return (
    <TableRow
      onClick={() => onSelect(event)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(event)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`查看${label}详情`}
      className="cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none"
    >
      <TableCell className="py-3 ps-4 whitespace-normal">
        <div className="flex items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
            <EventTypeIcon type={event.type} className="size-3.5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">
              {source}
              <span className="tabular-nums sm:hidden">
                {' '}
                · {shortTime(event.updated_at)}
              </span>
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </TableCell>
      <TableCell className="hidden text-end text-sm text-muted-foreground tabular-nums sm:table-cell">
        {shortTime(event.updated_at)}
      </TableCell>
      <TableCell className="pe-4 text-end text-muted-foreground">
        <ChevronRight className="ms-auto size-4" aria-hidden="true" />
      </TableCell>
    </TableRow>
  )
}
