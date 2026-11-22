import { useState } from 'react'
import { Smartphone, Unlink } from 'lucide-react'
import { time, useStore } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'

export function WatchPairing() {
  const data = useStore((s) => s.data!)
  const watches = data.notifier.watches
  const busy = useStore((s) => s.busy)
  const action = useStore((s) => s.action)
  const [removing, setRemoving] = useState<{
    id: string
    label: string
  } | null>(null)

  if (!watches.clients.length) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        暂无授权管理关注规则的设备。扫描下方配对二维码即可自动授权。
      </div>
    )
  }

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>已授权设备</span>
          <span className="tabular-nums">{watches.clients.length} 台</span>
        </div>
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {watches.clients.map((client) => (
            <li
              key={client.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
                  <Smartphone className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{client.label}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    最近活跃 {relativeTime(client.last_seen, data.now)} · 连接于{' '}
                    {time(client.created_at)}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() =>
                  setRemoving({ id: client.id, label: client.label })
                }
              >
                <Unlink className="size-3.5" />
                撤销
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setRemoving(null)
        }}
        title={`撤销「${removing?.label ?? ''}」的关注管理授权？`}
        desc="撤销后该设备将无法在 App 中修改关注规则（个人消息推送不受影响），重新扫码即可恢复。"
        confirmText="确认撤销"
        destructive
        isLoading={busy}
        handleConfirm={() => {
          if (removing)
            void action('/notifier/watch/clients/revoke', 'POST', {
              client_id: removing.id,
            }).then((ok) => {
              if (ok) setRemoving(null)
            })
        }}
        className="sm:max-w-md"
      />
    </>
  )
}
