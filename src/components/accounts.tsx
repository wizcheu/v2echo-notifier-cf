import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/api'
import type { NotifierAccount } from '../../shared/contracts'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { UserAvatar } from '@/components/user-avatar'
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
import { SettingsSection } from '@/components/settings-section'
import { cn } from '@/lib/utils'

const accountName = (account: NotifierAccount) =>
  account.username ? `@${account.username}` : '待配置账号'

function accountState(account: NotifierAccount): {
  label: string
  tone: StatusTone
} {
  if (account.blocked === 'deleting')
    return { label: '删除尚未完成，请重试', tone: 'danger' }
  if (account.blocked === 'credentials')
    return { label: '需要更新访问凭据', tone: 'danger' }
  if (account.blocked === 'pairing')
    return { label: '需要重新配对', tone: 'danger' }
  if (account.blocked) return { label: '账号存在异常', tone: 'warning' }
  if (!account.account_id) return { label: '待配置凭据', tone: 'neutral' }
  if (!account.binding_id) return { label: '等待 App 配对', tone: 'warning' }
  return account.enabled
    ? { label: '运行中', tone: 'success' }
    : { label: '已暂停', tone: 'neutral' }
}

function AddAccountForm({
  onClose,
  inline = false,
}: {
  onClose: () => void
  inline?: boolean
}) {
  const { busy, addAccount } = useStore()
  const [cookie, setCookie] = useState('')
  const [pat, setPAT] = useState('')
  const canSave = !busy && Boolean(cookie.trim() && pat.trim())

  return (
    <form
      className={cn(
        'flex flex-col gap-4',
        inline && 'rounded-lg border bg-card p-5'
      )}
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave)
          void addAccount(cookie.trim(), pat.trim()).then((created) => {
            if (created) {
              setCookie('')
              setPAT('')
              onClose()
            }
          })
      }}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="account-cookie">Cookie</Label>
          <Input
            id="account-cookie"
            type="password"
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            readOnly={busy}
            autoFocus
            placeholder="粘贴该账号的完整 Cookie"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="account-pat">Personal Access Token (PAT)</Label>
          <Input
            id="account-pat"
            type="password"
            value={pat}
            onChange={(event) => setPAT(event.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            readOnly={busy}
            placeholder="粘贴同一账号的个人访问令牌"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Cookie 与 PAT 须属于同一 V2EX 账号，验证通过后加密保存。
      </p>
      {inline ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={!canSave}>
            验证并添加
          </Button>
        </div>
      ) : (
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button type="submit" disabled={!canSave}>
            验证并添加
          </Button>
        </DialogFooter>
      )}
    </form>
  )
}

export function AccountManagement() {
  const {
    accounts,
    selectedAccountId,
    selectAccount,
    deleteAccount,
    busy,
    accountsPending,
  } = useStore()
  const [addOpen, setAddOpen] = useState(false)
  const [removing, setRemoving] = useState<NotifierAccount | null>(null)

  return (
    <>
      <SettingsSection
        title="已连接账号"
        description="每个 V2EX 账号独立保存凭据、配对设备与推送记录。"
        action={
          accounts.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setAddOpen(true)}
            >
              <Plus className="size-3.5" />
              添加账号
            </Button>
          ) : undefined
        }
      >
        {accounts.length > 0 ? (
          <div className="divide-y overflow-hidden rounded-lg border bg-card">
            {accounts.map((account) => {
              const state = accountState(account)
              const isCurrent = account.id === selectedAccountId
              return (
                <div
                  key={account.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 px-4 py-3 transition-colors',
                    isCurrent && 'bg-muted/35'
                  )}
                >
                  <UserAvatar
                    src={account.avatar_url || undefined}
                    name={account.username || '待配置账号'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {accountName(account)}
                      </p>
                      {isCurrent && (
                        <StatusBadge tone="info">当前</StatusBadge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {state.label}
                    </p>
                  </div>
                  {isCurrent ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={() => setRemoving(account)}
                    >
                      <Trash2 className="size-3.5" />
                      删除
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={accountsPending}
                      onClick={() => void selectAccount(account.id)}
                    >
                      切换
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <AddAccountForm inline onClose={() => undefined} />
        )}
      </SettingsSection>

      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!busy) setAddOpen(next)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加 V2EX 账号</DialogTitle>
            <DialogDescription>
              每个账号需在 V2Echo App 登录同一账号后分别扫码配对。
            </DialogDescription>
          </DialogHeader>
          <AddAccountForm onClose={() => setAddOpen(false)} />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setRemoving(null)
        }}
        title={`删除账号 ${removing ? accountName(removing) : ''}？`}
        desc="将撤销该账号的推送连接，并清空其凭据、关注规则和通知记录。其他账号不受影响。"
        confirmText="确认删除"
        destructive
        isLoading={busy}
        handleConfirm={() => {
          if (removing)
            void deleteAccount(removing.id).then(() => {
              setRemoving(null)
            })
        }}
        className="sm:max-w-md"
      />
    </>
  )
}
