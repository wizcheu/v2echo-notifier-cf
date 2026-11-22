import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Inbox,
  RefreshCw,
  X,
} from 'lucide-react'
import { format, request, time, useStore } from '@/lib/api'
import { shortTime } from '@/lib/format'
import type {
  CachedMessagesPage,
  MessageRecord,
  PersonalMessagesPage,
} from '../../shared/message-contracts'
import { NotificationCategoryBadge } from './notification-category'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { TableSkeleton } from '@/components/table-skeleton'
import { UserAvatar } from '@/components/user-avatar'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type MessageOperation =
  | { kind: 'read'; cursors: string[]; afterFetch?: true }
  | { kind: 'latest'; cursors: [] }
  | { kind: 'earlier'; cursors: string[]; page: number }

type CategoryFilter = 'all' | 'reply' | 'mention' | 'thanks' | 'favorite'

const categoryOptions: Array<{ value: CategoryFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'reply', label: '回复' },
  { value: 'mention', label: '提及' },
  { value: 'thanks', label: '感谢' },
  { value: 'favorite', label: '收藏' },
]

function matchesCategory(kind: string, filter: CategoryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'thanks') return kind === 'thanks_topic' || kind === 'thanks_reply'
  return kind === filter
}

function MessagesView({
  requestVersion,
  credentialsUpdatedAt,
}: {
  requestVersion: number
  credentialsUpdatedAt: number
}) {
  const busy = useStore((s) => s.busy)
  const [current, setCurrent] = useState<{
    page: CachedMessagesPage
    cursors: string[]
  } | null>(null)
  const [pending, setPending] = useState<MessageOperation | null>({
    kind: 'read',
    cursors: [],
  })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [selected, setSelected] = useState<MessageRecord | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<{
    operation: MessageOperation
    retry: MessageOperation
    message: string
  } | null>(null)
  const mounted = useRef(false)
  const active = useRef(false)

  const loadPage = useCallback(
    async (operation: MessageOperation) => {
      const isCurrent = () => {
        const state = useStore.getState()
        return (
          mounted.current &&
          state.requestVersion === requestVersion &&
          state.data?.credentials.updated_at === credentialsUpdatedAt
        )
      }
      if (active.current || !isCurrent()) return
      setError(null)
      active.current = true
      setPending(operation)
      let retry = operation
      try {
        if (operation.kind !== 'read') {
          await request<PersonalMessagesPage>(
            requestVersion,
            '/notifier/history',
            'POST',
            { page: operation.kind === 'latest' ? 1 : operation.page }
          )
          if (!isCurrent()) return
          retry = {
            kind: 'read',
            cursors: operation.cursors,
            afterFetch: true,
          }
        }
        const cursor = operation.cursors.at(-1)
        const queryString = cursor
          ? `?${new URLSearchParams({ cursor })}`
          : ''
        const page = await request<CachedMessagesPage>(
          requestVersion,
          `/notifier/messages${queryString}`
        )
        if (!isCurrent()) return
        setCurrent({ page, cursors: operation.cursors })
      } catch (err) {
        if (isCurrent())
          setError({
            operation,
            retry,
            message:
              err instanceof Error ? err.message : '个人消息读取失败',
          })
      } finally {
        active.current = false
        if (isCurrent()) setPending(null)
      }
    },
    [requestVersion, credentialsUpdatedAt]
  )

  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (mounted.current) void loadPage({ kind: 'read', cursors: [] })
    })
    return () => {
      mounted.current = false
    }
  }, [loadPage])

  const page = current?.page
  const cursors = current?.cursors ?? []
  const cacheReadFailed =
    error?.retry.kind === 'read' && error.retry.afterFetch
  const blocked = busy || pending !== null || Boolean(cacheReadFailed)
  const needle = query.trim().toLowerCase()

  const categoryCounts = useMemo(() => {
    const source = page?.items ?? []
    const counts: Record<CategoryFilter, number> = {
      all: source.length,
      reply: 0,
      mention: 0,
      thanks: 0,
      favorite: 0,
    }
    for (const item of source) {
      if (item.kind === 'reply') counts.reply += 1
      else if (item.kind === 'mention') counts.mention += 1
      else if (item.kind === 'thanks_topic' || item.kind === 'thanks_reply')
        counts.thanks += 1
      else if (item.kind === 'favorite') counts.favorite += 1
    }
    return counts
  }, [page])

  const items = useMemo(
    () =>
      (page?.items ?? []).filter(
        (item) =>
          matchesCategory(item.kind, category) &&
          (!needle ||
            `${item.title} ${item.body}`.toLowerCase().includes(needle))
      ),
    [page, category, needle]
  )

  const hasFilter = Boolean(needle) || category !== 'all'

  async function copyMessage(item: MessageRecord) {
    try {
      await navigator.clipboard.writeText(
        item.body ? `${item.title}\n${item.body}` : item.title
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* Clipboard unavailable */
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="个人消息"
        description={
          page && page.fetched_at > 0
            ? `最近同步 ${shortTime(page.fetched_at)}`
            : '从 V2EX 同步的个人回复、提及与互动消息。'
        }
        actions={
          <Button
            size="sm"
            disabled={blocked}
            onClick={() => void loadPage({ kind: 'latest', cursors: [] })}
          >
            {pending?.kind === 'latest' ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            获取最新数据
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>
            {cacheReadFailed
              ? '消息已获取，列表读取失败'
              : error.operation.kind === 'latest'
                ? '获取最新数据失败'
                : error.operation.kind === 'earlier'
                  ? '获取更早消息失败'
                  : !page
                    ? '个人消息读取失败'
                    : '翻页失败'}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {error.message}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || pending !== null}
              onClick={() => void loadPage(error.retry)}
            >
              {error.retry.kind === 'read' ? '重试读取' : '重试获取'}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="搜索个人消息"
          placeholder="搜索标题或内容…"
          className="h-8 w-full sm:w-56 lg:w-64"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div
          role="group"
          aria-label="按类型筛选"
          className="flex flex-wrap items-center gap-1"
        >
          {categoryOptions.map((option) => {
            const count = categoryCounts[option.value]
            const activePill = category === option.value
            if (option.value !== 'all' && page && count === 0 && !activePill)
              return null
            return (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={activePill ? 'secondary' : 'outline'}
                className={cn(
                  'h-8 px-2.5 text-xs',
                  !activePill && 'border-dashed text-muted-foreground'
                )}
                onClick={() => setCategory(option.value)}
              >
                {option.label}
                {page && count > 0 && option.value !== 'all' && (
                  <span className="ms-1 text-[11px] text-muted-foreground tabular-nums">
                    {count}
                  </span>
                )}
              </Button>
            )
          })}
        </div>
        {hasFilter && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setQuery('')
              setCategory('all')
            }}
          >
            重置
            <X className="size-3.5" />
          </Button>
        )}
        <div className="ms-auto flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {pending && page && (
            <span role="status" aria-live="polite">
              {pending.kind === 'latest'
                ? '正在同步…'
                : pending.kind === 'earlier'
                  ? '正在获取更早消息…'
                  : '加载中…'}
            </span>
          )}
          {page && (
            <span>
              {hasFilter
                ? `匹配 ${format(items.length)} / ${format(page.items.length)} 条`
                : `本页 ${format(items.length)} 条`}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        {pending && !page ? (
          <TableSkeleton rows={7} withAvatar />
        ) : items.length ? (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="ps-4">消息</TableHead>
                <TableHead className="hidden w-24 sm:table-cell">类型</TableHead>
                <TableHead className="hidden w-32 pe-4 text-end sm:table-cell">
                  时间
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.notification_id}
                  tabIndex={0}
                  role="button"
                  onClick={() => {
                    setCopied(false)
                    setSelected(item)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setCopied(false)
                      setSelected(item)
                    }
                  }}
                  className="cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none"
                >
                  <TableCell className="py-3 ps-4 whitespace-normal">
                    <div className="flex items-start gap-3">
                      <UserAvatar
                        src={item.avatar_url || undefined}
                        name={item.title}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {item.title}
                        </p>
                        {item.body && (
                          <p className="mt-0.5 line-clamp-2 wrap-anywhere text-xs leading-relaxed text-muted-foreground">
                            {item.body}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center gap-2 sm:hidden">
                          <NotificationCategoryBadge kind={item.kind} />
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {shortTime(item.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <NotificationCategoryBadge kind={item.kind} />
                  </TableCell>
                  <TableCell className="hidden pe-4 text-end text-xs text-muted-foreground tabular-nums sm:table-cell">
                    {shortTime(item.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : page ? (
          <div className="p-4">
            <EmptyState
              icon={<Inbox className="size-5" />}
              title={
                hasFilter
                  ? '没有匹配的消息'
                  : cursors.length
                    ? '本页没有缓存消息'
                    : '暂无个人消息'
              }
              action={
                hasFilter ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQuery('')
                      setCategory('all')
                    }}
                  >
                    清空筛选
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={blocked}
                    onClick={() => void loadPage({ kind: 'latest', cursors: [] })}
                  >
                    获取最新数据
                  </Button>
                )
              }
            >
              {hasFilter
                ? '尝试调整关键词或切换消息类型。'
                : '点击获取最新数据，从 V2EX 同步个人消息。'}
            </EmptyState>
          </div>
        ) : (
          <TableSkeleton rows={7} withAvatar />
        )}
      </div>

      {page && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            第 {format(cursors.length + 1)} 页
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || !cursors.length}
              onClick={() =>
                void loadPage({ kind: 'read', cursors: cursors.slice(0, -1) })
              }
            >
              <ChevronLeft className="size-4" />
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || page.next_cursor === null}
              onClick={() => {
                if (page.next_cursor !== null)
                  void loadPage({
                    kind: 'read',
                    cursors: [...cursors, page.next_cursor],
                  })
              }}
            >
              下一页
              <ChevronRight className="size-4" />
            </Button>
            {page.fetched_at > 0 &&
              page.next_cursor === null &&
              page.upstream_next_page !== null && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() =>
                    void loadPage({
                      kind: 'earlier',
                      cursors,
                      page: page.upstream_next_page!,
                    })
                  }
                >
                  获取更早消息
                </Button>
              )}
          </div>
        </div>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        {selected && (
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
            <DialogHeader className="pe-6">
              <div className="flex items-start gap-3">
                <UserAvatar
                  src={selected.avatar_url || undefined}
                  name={selected.title}
                  className="mt-0.5 size-9"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <DialogTitle className="leading-snug">
                    {selected.title}
                  </DialogTitle>
                  <DialogDescription className="flex flex-wrap items-center gap-2">
                    <NotificationCategoryBadge kind={selected.kind} />
                    <span className="tabular-nums">
                      {time(selected.created_at)}
                    </span>
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            {selected.body && (
              <div className="rounded-lg border bg-muted/30 p-3.5 text-sm leading-relaxed whitespace-pre-wrap select-text">
                {selected.body}
              </div>
            )}
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyMessage(selected)}
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? '已复制' : '复制内容'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelected(null)}
              >
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

export default function Messages() {
  const requestVersion = useStore((s) => s.requestVersion)
  const credentialsUpdatedAt = useStore((s) => s.data!.credentials.updated_at)
  return (
    <MessagesView
      key={`${requestVersion}:${credentialsUpdatedAt}`}
      requestVersion={requestVersion}
      credentialsUpdatedAt={credentialsUpdatedAt}
    />
  )
}
