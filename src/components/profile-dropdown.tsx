import { useState } from 'react'
import { Bell, LogOut, Smartphone, UserCog } from 'lucide-react'
import { useStore } from '@/lib/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function ProfileDropdown() {
  const [open, setOpen] = useState(false)
  const accounts = useStore((state) => state.accounts)
  const selectedAccountId = useStore((state) => state.selectedAccountId)
  const data = useStore((state) => state.data)
  const busy = useStore((state) => state.busy)
  const logout = useStore((state) => state.logout)
  const current = accounts.find((account) => account.id === selectedAccountId)
  const username = current?.username || data?.notifier.username || 'V2EX'
  const name = current?.username ? `@${current.username}` : '待配置账号'
  const avatar = current?.avatar_url || undefined

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            aria-label="账号菜单"
            className="relative size-8 rounded-full"
          >
            <Avatar className="size-8">
              {avatar && <AvatarImage src={avatar} alt={name} />}
              <AvatarFallback>
                {username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" align="end">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-1">
              <p className="truncate text-sm leading-none font-medium">{name}</p>
              <p className="text-xs leading-none text-muted-foreground">
                {current ? '当前 V2EX 账号' : '尚未连接账号'}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <a href="#settings-notifications">
                <Bell className="size-4" />
                通知策略
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href="#settings-accounts">
                <UserCog className="size-4" />
                账号与凭据
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href="#settings-devices">
                <Smartphone className="size-4" />
                设备配对
              </a>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            <LogOut className="size-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
        title="退出登录？"
        desc="退出后需要重新输入管理密钥才能进入通知助手。"
        confirmText="退出登录"
        destructive
        isLoading={busy}
        handleConfirm={() => {
          void logout().finally(() => setOpen(false))
        }}
        className="sm:max-w-sm"
      />
    </>
  )
}
