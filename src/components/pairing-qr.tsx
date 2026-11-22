import { useEffect, useRef, useState } from 'react'
import QRCode from 'react-qr-code'
import { Check, Copy, QrCode, RefreshCw } from 'lucide-react'
import type {
  PairingConfirmation,
  PairingInvitation,
} from '../../shared/contracts'
import { performAction, useStore } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'

export function PairingQR({
  onPaired,
  transfer = false,
}: {
  onPaired: () => void
  transfer?: boolean
}) {
  const s = useStore((state) => state.data!.notifier)
  const busy = useStore((state) => state.busy)
  const [generated, setInvitation] = useState<
    | (PairingInvitation & {
        bindingAt: number
        bindingID: string
        clientIDs: string[]
      })
    | null
  >(null)
  const invitation = generated?.bindingAt === s.paired_at ? generated : null
  const [now, setNow] = useState(Date.now)
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState('')
  const [error, setError] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active.current = false
      window.clearInterval(timer)
    }
  }, [])

  const remaining = invitation
    ? Math.max(0, Math.ceil((invitation.expires_at - now) / 1000))
    : 0
  const cooldown = Math.max(0, Math.ceil((s.pair_until - now) / 1000))
  const disabled =
    busy ||
    !s.storage_ready ||
    cooldown > 0 ||
    (!transfer && window.location.protocol !== 'https:')
  const payload = !invitation
    ? ''
    : transfer
      ? (invitation.payload ?? '')
      : `v2echo://notifier-pair?${new URLSearchParams({
          url: window.location.origin,
          code: invitation.code,
        })}`

  async function generate() {
    setCopied(false)
    setError('')
    setCheckNote('')
    const result = await performAction<PairingInvitation>(
      transfer ? '/notifier/transfer' : '/notifier/pair/qr',
      'POST',
      {
        join_existing: Boolean(s.binding_id) && s.blocked !== 'pairing',
      }
    )
    if (active.current && result) {
      setInvitation({
        ...result,
        bindingAt: s.paired_at,
        bindingID: s.binding_id,
        clientIDs: s.watches.clients.map((client) => client.id),
      })
      setNow(Date.now())
    }
  }

  async function check() {
    if (!generated || checking || busy) return
    setChecking(true)
    setError('')
    setCheckNote('')
    try {
      await useStore.getState().refresh()
    } finally {
      if (active.current) setChecking(false)
    }
    if (!active.current) return
    const state = useStore.getState()
    if (state.error) return
    const fresh = state.data?.notifier
    if (!fresh) return
    const joined = fresh.watches.clients.some(
      (client) => !generated.clientIDs.includes(client.id)
    )
    if (
      fresh.paired_at !== generated.bindingAt ||
      fresh.binding_id !== generated.bindingID ||
      joined
    ) {
      setInvitation(null)
      useStore.setState({ message: '已检测到新的 App 连接，配对完成。' })
      onPaired()
    } else {
      setCheckNote('尚未检测到新设备，请在 App 确认完成后再刷新状态。')
    }
  }

  async function complete() {
    if (!invitation) return
    const result = await performAction<PairingConfirmation>(
      '/notifier/transfer/complete',
      'POST',
      { code: invitation.code }
    )
    if (!active.current) return
    if (result?.paired) {
      setInvitation(null)
      onPaired()
    } else if (!result) setInvitation(null)
  }

  async function copy() {
    if (!invitation) return
    try {
      await navigator.clipboard.writeText(payload)
      if (active.current) {
        setCopied(true)
        setError('')
      }
    } catch {
      if (active.current) setError('复制失败，请展开下方配对内容手动复制。')
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {s.username && <>请使用 @{s.username} 登录的 App 扫码。</>}
        {transfer
          ? '在已连接旧助手的 App 中确认迁移，完成后再扫描普通配对码即可。'
          : s.binding_id && s.blocked !== 'pairing'
            ? '添加新设备将保留现有设备与关注规则。'
            : '扫码后自动完成个人提醒绑定与关注管理授权。'}
      </p>

      {invitation && remaining > 0 ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="w-fit shrink-0 rounded-lg bg-white p-3.5 ring-1 ring-black/5">
            <QRCode
              value={payload}
              size={168}
              level="M"
              title="通知助手配对二维码"
              style={{ height: 'auto', width: '100%' }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-xs font-medium text-muted-foreground tabular-nums">
              剩余有效时间 {Math.floor(remaining / 60)} 分 {remaining % 60} 秒
            </p>
            <div className="flex flex-wrap gap-2">
              {transfer ? (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void complete()}
                >
                  检查迁移结果
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || checking}
                  onClick={() => void check()}
                >
                  {checking ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  检查配对状态
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void copy()}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? '已复制' : '复制配对内容'}
              </Button>
            </div>
            {checkNote && (
              <p className="text-xs text-muted-foreground" role="status">
                {checkNote}
              </p>
            )}
            <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  {moreOpen ? '隐藏手动配对内容' : '无法扫码？手动粘贴内容'}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="CollapsibleContent pt-2.5">
                <div className="flex flex-col gap-2.5">
                  <p className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs break-all select-all">
                    {payload}
                  </p>
                  {!transfer && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      disabled={disabled}
                      onClick={() => void generate()}
                    >
                      重新生成二维码
                    </Button>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={disabled} onClick={() => void generate()}>
            <QrCode className="size-3.5" />
            {transfer
              ? '生成迁移二维码'
              : invitation
                ? '重新生成二维码'
                : '生成配对二维码'}
          </Button>
          {transfer && invitation && remaining === 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void complete()}
            >
              检查上次迁移结果
            </Button>
          )}
          {invitation && (
            <span className="text-xs text-muted-foreground" role="status">
              二维码已过期
            </span>
          )}
        </div>
      )}

      {!transfer && window.location.protocol !== 'https:' && (
        <Alert>
          <AlertTitle>需要 HTTPS 访问</AlertTitle>
          <AlertDescription>
            请在公开 HTTPS 域名下打开通知助手后生成配对二维码。
          </AlertDescription>
        </Alert>
      )}
      {cooldown > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          操作过于频繁，请在 {cooldown} 秒后重试。
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>复制失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
