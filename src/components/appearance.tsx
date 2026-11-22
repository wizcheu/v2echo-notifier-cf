import { Check } from 'lucide-react'
import { useTheme } from '@/context/theme-provider'
import { accents, useAccent } from '@/context/accent-provider'
import { SettingsSection } from './settings-section'
import { cn } from '@/lib/utils'

const modes = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const

function Preview({ mode }: { mode: 'system' | 'light' | 'dark' }) {
  if (mode === 'system') {
    return (
      <span className="grid grid-cols-2 overflow-hidden rounded-sm">
        <span className="block space-y-2 bg-[#ecedef] p-2 pe-1">
          <span className="block space-y-1.5 rounded-s-md bg-white p-2 shadow-xs">
            <span className="block h-1.5 w-10 rounded-lg bg-[#ecedef]" />
            <span className="block h-1.5 w-12 rounded-lg bg-[#ecedef]" />
          </span>
          <span className="flex items-center space-x-1.5 rounded-s-md bg-white p-2 shadow-xs">
            <span className="block size-3 rounded-full bg-[#ecedef]" />
            <span className="block h-1.5 w-8 rounded-lg bg-[#ecedef]" />
          </span>
        </span>
        <span className="block space-y-2 bg-slate-950 p-2 ps-1">
          <span className="block space-y-1.5 rounded-e-md bg-slate-800 p-2 shadow-xs">
            <span className="block h-1.5 w-10 rounded-lg bg-slate-400" />
            <span className="block h-1.5 w-12 rounded-lg bg-slate-400" />
          </span>
          <span className="flex items-center space-x-1.5 rounded-e-md bg-slate-800 p-2 shadow-xs">
            <span className="block size-3 rounded-full bg-slate-400" />
            <span className="block h-1.5 w-8 rounded-lg bg-slate-400" />
          </span>
        </span>
      </span>
    )
  }

  const dark = mode === 'dark'
  return (
    <span
      className={cn(
        'block space-y-2 rounded-sm p-2',
        dark ? 'bg-slate-950' : 'bg-[#ecedef]'
      )}
    >
      <span
        className={cn(
          'block space-y-1.5 rounded-md p-2 shadow-xs',
          dark ? 'bg-slate-800' : 'bg-white'
        )}
      >
        <span
          className={cn(
            'block h-1.5 w-16 rounded-lg',
            dark ? 'bg-slate-400' : 'bg-[#ecedef]'
          )}
        />
        <span
          className={cn(
            'block h-1.5 w-20 rounded-lg',
            dark ? 'bg-slate-400' : 'bg-[#ecedef]'
          )}
        />
      </span>
      <span
        className={cn(
          'flex items-center space-x-2 rounded-md p-2 shadow-xs',
          dark ? 'bg-slate-800' : 'bg-white'
        )}
      >
        <span
          className={cn(
            'block size-3 rounded-full',
            dark ? 'bg-slate-400' : 'bg-[#ecedef]'
          )}
        />
        <span
          className={cn(
            'block h-1.5 w-16 rounded-lg',
            dark ? 'bg-slate-400' : 'bg-[#ecedef]'
          )}
        />
      </span>
    </span>
  )
}

export function Appearance() {
  const { theme, setTheme } = useTheme()
  const { accent, setAccent } = useAccent()

  return (
    <SettingsSection
      title="外观"
      description="自定义主题模式与主色调，设置保存在当前浏览器中。"
    >
      <div className="space-y-2.5">
        <p className="text-sm font-medium">主题模式</p>
        <div
          role="radiogroup"
          aria-label="外观模式"
          className="grid max-w-lg grid-cols-3 gap-4"
        >
          {modes.map((option) => {
            const selected = theme === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(option.value)}
                className="text-start outline-none"
              >
                <span
                  className={cn(
                    'block items-center rounded-md border-2 p-1 transition-colors',
                    selected
                      ? 'border-primary'
                      : 'border-muted hover:border-accent'
                  )}
                >
                  <Preview mode={option.value} />
                </span>
                <span
                  className={cn(
                    'block w-full pt-2 text-center text-xs',
                    selected
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  )}
                >
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-3 pt-2">
        <p className="text-sm font-medium">主题色</p>
        <div
          role="radiogroup"
          aria-label="选择主题色"
          className="flex flex-wrap gap-4"
        >
          {accents.map((item) => {
            const selected = accent === item.value
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setAccent(item.value)}
                className="group flex flex-col items-center gap-1.5 outline-none"
              >
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-all duration-150',
                    selected
                      ? 'scale-105 ring-2 ring-ring'
                      : 'ring-1 ring-border group-hover:scale-105 group-hover:ring-ring/60'
                  )}
                  style={{ background: `var(--swatch-${item.value})` }}
                >
                  {selected && (
                    <Check
                      className="size-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span
                  className={cn(
                    'text-xs',
                    selected
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  )}
                >
                  {item.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </SettingsSection>
  )
}
