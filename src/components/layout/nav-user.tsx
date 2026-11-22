import { useState } from 'react'
import {
  Bell,
  ChevronsUpDown,
  LogOut,
  Smartphone,
  UserCog,
} from 'lucide-react'
import { useStore } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { UserAvatar } from '@/components/user-avatar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export type AccountUser = {
  name: string
  detail: string
  avatar?: string
  statusTone: 'success' | 'warning' | 'danger' | 'neutral'
}

const dotClass: Record<AccountUser['statusTone'], string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-destructive',
  neutral: 'bg-muted-foreground/50',
}

export function NavUser({ user }: { user: AccountUser }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const busy = useStore((state) => state.busy)
  const logout = useStore((state) => state.logout)

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <UserAvatar src={user.avatar} name={user.name} />
                <div className="grid flex-1 text-start text-sm leading-tight">
                  <span className="truncate font-semibold">{user.name}</span>
                  <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        dotClass[user.statusTone]
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{user.detail}</span>
                  </span>
                </div>
                <ChevronsUpDown className="ms-auto size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
              side={isMobile ? 'bottom' : 'right'}
              align="end"
              sideOffset={4}
            >
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
                  <Avatar className="size-8 rounded-lg">
                    {user.avatar && (
                      <AvatarImage src={user.avatar} alt={user.name} />
                    )}
                    <AvatarFallback className="rounded-lg">
                      {user.name.replace(/^@/, '').slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-start text-sm leading-tight">
                    <span className="truncate font-semibold">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user.detail}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <a
                    href="#settings-notifications"
                    onClick={() => setOpenMobile(false)}
                  >
                    <Bell />
                    通知策略
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href="#settings-accounts"
                    onClick={() => setOpenMobile(false)}
                  >
                    <UserCog />
                    账号与凭据
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href="#settings-devices"
                    onClick={() => setOpenMobile(false)}
                  >
                    <Smartphone />
                    设备配对
                  </a>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setOpen(true)}
              >
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

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
