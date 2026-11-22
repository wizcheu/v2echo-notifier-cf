import { useState } from 'react'
import { Globe, Plug, Trash2 } from 'lucide-react'
import { performAction, useStore } from '@/lib/api'
import type { HttpProxyTestResult } from '../../shared/proxy-types'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

export function HttpProxySettings() {
  const data = useStore((s) => s.proxy)!
  const busy = useStore((s) => s.busy)
  const action = useStore((s) => s.action)
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearing, setClearing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HttpProxyTestResult | null>(null)

  const disabled = busy || testing || !data.encryption_ready
  const hasDraft = Boolean(address || username || password)
  const canTest =
    !disabled && (hasDraft ? Boolean(address.trim()) : data.configured)

  async function save(enabled: boolean, remove = false, replace = false) {
    setTestResult(null)
    if (
      await action('/proxy-settings', 'PUT', {
        enabled,
        remove,
        ...(replace ? { address, username, password } : {}),
      })
    ) {
      setAddress('')
      setUsername('')
      setPassword('')
      setClearing(false)
      setEditing(false)
    }
  }

  async function test() {
    if (!canTest || useStore.getState().busy) return
    const requestVersion = useStore.getState().requestVersion
    setTesting(true)
    setTestResult(null)
    try {
      const result = await performAction<HttpProxyTestResult>(
        '/proxy-settings/test',
        'POST',
        hasDraft ? { address, username, password } : {}
      )
      const current = useStore.getState()
      if (current.requestVersion !== requestVersion) return
      if (result && current.message === '操作已完成')
        useStore.setState({ message: '' })
      setTestResult(result)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
            <Globe className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">当前网络出口</span>
              <StatusBadge tone={data.enabled ? 'success' : 'neutral'}>
                {data.enabled ? '代理已启用' : '直接连接'}
              </StatusBadge>
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {data.address || '未配置代理，直接请求上游服务'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {data.configured && !editing && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canTest}
                onClick={() => void test()}
              >
                {testing && <Spinner className="size-3.5" />}
                测试连通
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || testing}
                onClick={() => void save(!data.enabled)}
              >
                {data.enabled ? '停用' : '启用'}
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant={editing ? 'ghost' : 'outline'}
            disabled={disabled}
            onClick={() => {
              setEditing((prev) => !prev)
              setTestResult(null)
            }}
          >
            <Plug className="size-3.5" />
            {editing ? '收起' : data.configured ? '修改代理' : '配置代理'}
          </Button>
          {data.configured && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground hover:text-destructive"
              aria-label="清除代理配置"
              disabled={busy || testing}
              onClick={() => {
                setClearing(true)
                setTestResult(null)
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <form
          className="animate-page-in flex flex-col gap-4 rounded-lg border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!disabled && address.trim()) void save(true, false, true)
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="proxy-address">代理地址</Label>
            <Input
              id="proxy-address"
              type="url"
              value={address}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="http://proxy.example.com:8080 或 socks5://…"
              onChange={(event) => {
                setAddress(event.target.value.slice(0, 2048))
                setTestResult(null)
              }}
              disabled={disabled}
              required
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="proxy-username">用户名（可选）</Label>
              <Input
                id="proxy-username"
                value={username}
                autoComplete="off"
                spellCheck={false}
                placeholder={data.authenticated ? '已配置，替换时重填' : ''}
                onChange={(event) => {
                  setUsername(event.target.value.slice(0, 256))
                  setTestResult(null)
                }}
                disabled={disabled}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="proxy-password">密码（可选）</Label>
              <Input
                id="proxy-password"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => {
                  setPassword(event.target.value.slice(0, 512))
                  setTestResult(null)
                }}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="submit"
              size="sm"
              disabled={disabled || !address.trim()}
            >
              保存并启用
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canTest}
              onClick={() => void test()}
            >
              {testing && <Spinner className="size-3.5" />}
              测试连接
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || testing}
              onClick={() => {
                setEditing(false)
                setTestResult(null)
              }}
            >
              取消
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            账号密码加密保存且不回显；测试仅探测 V2EX 首页可达性，不携带账号凭据。
          </p>
        </form>
      )}

      {testResult && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs"
        >
          <p
            className={
              testResult.ok
                ? 'font-medium text-emerald-700 dark:text-emerald-400'
                : 'font-medium text-destructive'
            }
          >
            测试结果：{testResult.message}
          </p>
          <p className="mt-0.5 text-muted-foreground tabular-nums">
            {testResult.proxy_address}
            {testResult.http_status !== null && ` · HTTP ${testResult.http_status}`}
            {` · ${testResult.duration_ms} ms`}
          </p>
        </div>
      )}

      {!data.encryption_ready && (
        <Alert variant="destructive">
          <AlertTitle>加密密钥不可用</AlertTitle>
          <AlertDescription>
            服务端尚未配置有效的 NOTIFIER_KEY，暂时无法保存代理配置。
          </AlertDescription>
        </Alert>
      )}

      <ConfirmDialog
        open={clearing}
        onOpenChange={(next) => {
          if (!busy && !testing) setClearing(next)
        }}
        title="清除代理配置？"
        desc="清除后将恢复直接连接，如需再次使用代理需要重新填写地址与鉴权信息。"
        confirmText="确认清除"
        destructive
        isLoading={busy || testing}
        handleConfirm={() => void save(false, true)}
        className="sm:max-w-sm"
      />
    </div>
  )
}
