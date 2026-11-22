import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { time, useStore } from '@/lib/api'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

function CredentialsForm({
  isCoolingDown,
  onClose,
  inline = false,
}: {
  isCoolingDown: boolean
  onClose: () => void
  inline?: boolean
}) {
  const data = useStore((state) => state.data)!
  const busy = useStore((state) => state.busy)
  const action = useStore((state) => state.action)
  const [cookie, setCookie] = useState('')
  const [pat, setPAT] = useState('')
  const [saving, setSaving] = useState(false)

  const nextCookie = cookie.trim()
  const nextPAT = pat.trim()
  const canSave =
    !busy &&
    !isCoolingDown &&
    data.notifier.storage_ready &&
    Boolean(nextCookie || nextPAT) &&
    Boolean(nextCookie || data.credentials.cookie) &&
    Boolean(nextPAT || data.credentials.pat)

  async function save() {
    if (!canSave) return
    setSaving(true)
    const saved = await action('/notifier/credentials', 'PUT', {
      ...(nextCookie ? { cookie: nextCookie } : {}),
      ...(nextPAT ? { pat: nextPAT } : {}),
    })
    setSaving(false)
    if (saved) {
      setCookie('')
      setPAT('')
      onClose()
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="credentials-cookie">Cookie</Label>
          <Input
            id="credentials-cookie"
            type="password"
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            readOnly={busy}
            required={!data.credentials.cookie}
            placeholder={
              data.credentials.cookie
                ? '留空保留当前 Cookie'
                : '粘贴完整 Cookie'
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="credentials-pat">Personal Access Token (PAT)</Label>
          <Input
            id="credentials-pat"
            type="password"
            value={pat}
            onChange={(event) => setPAT(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            readOnly={busy}
            required={!data.credentials.pat}
            placeholder={
              data.credentials.pat ? '留空保留当前 PAT' : '粘贴个人访问令牌'
            }
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        验证通过后加密保存，验证失败保留原配置。
      </p>
      {inline ? (
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving && <Spinner className="size-3.5" />}
            验证并保存
          </Button>
        </div>
      ) : (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving && <Spinner className="size-3.5" />}
            验证并保存
          </Button>
        </DialogFooter>
      )}
    </form>
  )
}

export function CredentialsSettings({
  isCoolingDown,
}: {
  isCoolingDown: boolean
}) {
  const data = useStore((state) => state.data)!
  const busy = useStore((state) => state.busy)
  const ready =
    data.credentials.cookie &&
    data.credentials.pat &&
    data.notifier.storage_ready
  const [dialogOpen, setDialogOpen] = useState(false)

  if (!ready) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <CredentialsForm
          inline
          isCoolingDown={isCoolingDown}
          onClose={() => undefined}
        />
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">访问凭据</span>
            <StatusBadge tone="success">已加密保存</StatusBadge>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {data.credentials.source === 'settings'
              ? `Cookie 与 PAT 更新于 ${time(data.credentials.updated_at)}`
              : '当前使用 Cloudflare Secrets 中的访问凭据'}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !data.notifier.storage_ready}
          onClick={() => setDialogOpen(true)}
        >
          <KeyRound className="size-3.5" />
          更新凭据
        </Button>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!busy) setDialogOpen(next)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>更新访问凭据</DialogTitle>
            <DialogDescription>
              仅更新当前账号；留空的字段将保持不变。
            </DialogDescription>
          </DialogHeader>
          <CredentialsForm
            isCoolingDown={isCoolingDown}
            onClose={() => setDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
