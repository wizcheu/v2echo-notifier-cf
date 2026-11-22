import { useState } from 'react'
import {
  ArrowUpRight,
  Check,
  Copy,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { request, time, useStore } from '@/lib/api'
import type { VersionCheckResult } from '../../shared/contracts'
import { APP_VERSION, RELEASES_PAGE_URL } from '../../shared/version'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function VersionInfo() {
  const requestVersion = useStore((state) => state.requestVersion)
  const serverVersion = useStore((state) => state.data?.version)
  const currentVersion = serverVersion || APP_VERSION

  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<VersionCheckResult | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const updateCommand = result?.latest_version
    ? `npm run update -- v${result.latest_version}`
    : 'npm run update'

  async function handleCheck() {
    if (checking) return
    setChecking(true)
    setError('')
    try {
      const data = await request<VersionCheckResult>(
        requestVersion,
        '/version/check'
      )
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '检查更新失败，请稍后重试')
    } finally {
      setChecking(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(updateCommand)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* Clipboard API may be unavailable in restricted contexts. */
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">当前版本</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
              v{currentVersion}
            </code>
            {result?.latest_version && !result.has_update && (
              <StatusBadge tone="success">已是最新</StatusBadge>
            )}
            {result?.has_update && result.latest_version && (
              <StatusBadge tone="warning">
                有新版本 v{result.latest_version}
              </StatusBadge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {result?.checked_at
              ? `上次检查：${time(result.checked_at)}`
              : '仅在手动点击时向 GitHub Releases 查询最新版本，不在后台自动外联。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={checking}
            onClick={() => void handleCheck()}
          >
            <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
            {checking ? '检查中…' : '检查更新'}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a
              href={result?.release_url ?? RELEASES_PAGE_URL}
              target="_blank"
              rel="noreferrer"
            >
              发行说明
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {result?.note && !error && (
        <p className="text-xs text-muted-foreground">{result.note}</p>
      )}

      {result?.has_update && result.latest_version && (
        <Alert className="border-primary/30 bg-primary/5">
          <Sparkles className="size-4" />
          <AlertTitle>
            发现新版本 v{result.latest_version}
          </AlertTitle>
          <AlertDescription className="flex w-full flex-col gap-2">
            <span>
              在你的本地助手目录运行以下命令即可自动下载官方预构建包、校验并完成更新（保留云端密钥与数据）：
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded border bg-background px-2 py-1 font-mono text-xs text-foreground">
                {updateCommand}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <>
                    <Check className="size-3.5" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    复制命令
                  </>
                )}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
