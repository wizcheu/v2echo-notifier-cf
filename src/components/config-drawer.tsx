import { type SVGProps } from 'react'
import { Root as Radio, Item } from '@radix-ui/react-radio-group'
import { Check, CircleCheck, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { IconLayoutCompact } from '@/assets/custom/icon-layout-compact'
import { IconLayoutDefault } from '@/assets/custom/icon-layout-default'
import { IconLayoutFull } from '@/assets/custom/icon-layout-full'
import { IconSidebarFloating } from '@/assets/custom/icon-sidebar-floating'
import { IconSidebarInset } from '@/assets/custom/icon-sidebar-inset'
import { IconSidebarSidebar } from '@/assets/custom/icon-sidebar-sidebar'
import { IconThemeDark } from '@/assets/custom/icon-theme-dark'
import { IconThemeLight } from '@/assets/custom/icon-theme-light'
import { IconThemeSystem } from '@/assets/custom/icon-theme-system'
import { cn } from '@/lib/utils'
import { accents, useAccent } from '@/context/accent-provider'
import { type Collapsible, useLayout } from '@/context/layout-provider'
import { useTheme } from '@/context/theme-provider'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useSidebar } from './ui/sidebar'

export function ConfigDrawer() {
  const { setOpen } = useSidebar()
  const { resetTheme } = useTheme()
  const { resetAccent } = useAccent()
  const { resetLayout } = useLayout()

  const handleReset = () => {
    setOpen(true)
    resetTheme()
    resetAccent()
    resetLayout()
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label="外观与布局"
          className="size-8 rounded-full"
        >
          <SlidersHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col">
        <SheetHeader className="pb-0 text-start">
          <SheetTitle>外观与布局</SheetTitle>
          <SheetDescription>偏好保存在当前浏览器中。</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 overflow-y-auto px-4 pt-1">
          <ThemeConfig />
          <AccentConfig />
          <SidebarConfig />
          <LayoutConfig />
        </div>
        <SheetFooter className="gap-2">
          <Button
            variant="outline"
            onClick={handleReset}
            aria-label="恢复默认外观与布局"
          >
            <RotateCcw className="size-4" />
            恢复默认
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function SectionTitle({
  title,
  showReset = false,
  onReset,
  resetAriaLabel,
  className,
}: {
  title: string
  showReset?: boolean
  onReset?: () => void
  resetAriaLabel?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground',
        className
      )}
    >
      {title}
      {showReset && onReset && (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="size-4 rounded-full"
          onClick={onReset}
          aria-label={resetAriaLabel}
        >
          <RotateCcw className="size-3" />
        </Button>
      )}
    </div>
  )
}

function RadioGroupItem({
  item,
  isTheme = false,
}: {
  item: {
    value: string
    label: string
    icon: (props: SVGProps<SVGSVGElement>) => React.ReactElement
  }
  isTheme?: boolean
}) {
  return (
    <Item
      value={item.value}
      className="group outline-none transition duration-150 ease-out"
      aria-label={`选择${item.label}`}
      aria-describedby={`${item.value}-description`}
    >
      <div
        className={cn(
          'relative rounded-[6px] ring-[1px] ring-border transition-shadow',
          'group-data-[state=checked]:shadow-sm group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-primary',
          'group-focus-visible:ring-2'
        )}
        role="img"
        aria-hidden="false"
        aria-label={`${item.label}预览`}
      >
        <CircleCheck
          className={cn(
            'size-5 fill-primary stroke-primary-foreground',
            'group-data-[state=unchecked]:hidden',
            'absolute top-0 right-0 translate-x-1/2 -translate-y-1/2'
          )}
          aria-hidden="true"
        />
        <item.icon
          className={cn(
            !isTheme &&
              'fill-primary stroke-primary group-data-[state=unchecked]:fill-muted-foreground group-data-[state=unchecked]:stroke-muted-foreground'
          )}
          aria-hidden="true"
        />
      </div>
      <div
        className="mt-1.5 text-xs text-muted-foreground group-data-[state=checked]:font-medium group-data-[state=checked]:text-foreground"
        id={`${item.value}-description`}
      >
        {item.label}
      </div>
    </Item>
  )
}

function ThemeConfig() {
  const { defaultTheme, theme, setTheme } = useTheme()
  return (
    <div>
      <SectionTitle
        title="主题"
        showReset={theme !== defaultTheme}
        onReset={() => setTheme(defaultTheme)}
        resetAriaLabel="恢复默认主题"
      />
      <Radio
        value={theme}
        onValueChange={setTheme}
        className="grid w-full max-w-md grid-cols-3 gap-4"
        aria-label="选择主题"
      >
        {[
          { value: 'system', label: '跟随系统', icon: IconThemeSystem },
          { value: 'light', label: '浅色', icon: IconThemeLight },
          { value: 'dark', label: '深色', icon: IconThemeDark },
        ].map((item) => (
          <RadioGroupItem key={item.value} item={item} isTheme />
        ))}
      </Radio>
    </div>
  )
}

function AccentConfig() {
  const { defaultAccent, accent, setAccent, resetAccent } = useAccent()
  return (
    <div>
      <SectionTitle
        title="主题色"
        showReset={accent !== defaultAccent}
        onReset={resetAccent}
        resetAriaLabel="恢复默认主题色"
      />
      <div
        role="radiogroup"
        aria-label="选择主题色"
        className="flex flex-wrap gap-3.5"
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
  )
}

function SidebarConfig() {
  const { defaultVariant, variant, setVariant } = useLayout()
  return (
    <div className="max-md:hidden">
      <SectionTitle
        title="侧栏样式"
        showReset={defaultVariant !== variant}
        onReset={() => setVariant(defaultVariant)}
        resetAriaLabel="恢复默认侧栏样式"
      />
      <Radio
        value={variant}
        onValueChange={setVariant}
        className="grid w-full max-w-md grid-cols-3 gap-4"
        aria-label="选择侧栏样式"
      >
        {[
          { value: 'inset', label: '嵌入', icon: IconSidebarInset },
          { value: 'floating', label: '浮动', icon: IconSidebarFloating },
          { value: 'sidebar', label: '标准', icon: IconSidebarSidebar },
        ].map((item) => (
          <RadioGroupItem key={item.value} item={item} />
        ))}
      </Radio>
    </div>
  )
}

function LayoutConfig() {
  const { open, setOpen } = useSidebar()
  const { defaultCollapsible, collapsible, setCollapsible } = useLayout()

  const radioState = open ? 'default' : collapsible

  return (
    <div className="max-md:hidden">
      <SectionTitle
        title="侧栏展开"
        showReset={radioState !== 'default'}
        onReset={() => {
          setOpen(true)
          setCollapsible(defaultCollapsible)
        }}
        resetAriaLabel="恢复默认侧栏展开方式"
      />
      <Radio
        value={radioState}
        onValueChange={(v) => {
          if (v === 'default') {
            setOpen(true)
            return
          }
          setOpen(false)
          setCollapsible(v as Collapsible)
        }}
        className="grid w-full max-w-md grid-cols-3 gap-4"
        aria-label="选择侧栏展开方式"
      >
        {[
          { value: 'default', label: '展开', icon: IconLayoutDefault },
          { value: 'icon', label: '紧凑', icon: IconLayoutCompact },
          { value: 'offcanvas', label: '隐藏', icon: IconLayoutFull },
        ].map((item) => (
          <RadioGroupItem key={item.value} item={item} />
        ))}
      </Radio>
    </div>
  )
}
