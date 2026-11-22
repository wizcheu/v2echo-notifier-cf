import { createContext, useContext, useEffect, useState } from 'react'
import { getCookie, setCookie, removeCookie } from '@/lib/cookies'

export const accents = [
  { value: 'neutral', label: '中性' },
  { value: 'blue', label: '雾蓝' },
  { value: 'green', label: '鼠尾草' },
  { value: 'rose', label: '豆沙' },
  { value: 'orange', label: '蜜杏' },
  { value: 'violet', label: '香芋' },
] as const

export type Accent = (typeof accents)[number]['value']

const DEFAULT_ACCENT: Accent = 'neutral'
const ACCENT_COOKIE_NAME = 'vite-ui-accent'
const ACCENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

type AccentContextType = {
  defaultAccent: Accent
  accent: Accent
  setAccent: (accent: Accent) => void
  resetAccent: () => void
}

const AccentContext = createContext<AccentContextType | null>(null)

function applyAccent(accent: Accent) {
  const root = window.document.documentElement
  if (accent === DEFAULT_ACCENT) root.removeAttribute('data-accent')
  else root.setAttribute('data-accent', accent)
}

export function AccentProvider({ children }: { children: React.ReactNode }) {
  const [accent, _setAccent] = useState<Accent>(
    () => (getCookie(ACCENT_COOKIE_NAME) as Accent) || DEFAULT_ACCENT
  )

  useEffect(() => {
    applyAccent(accent)
  }, [accent])

  const setAccent = (accent: Accent) => {
    setCookie(ACCENT_COOKIE_NAME, accent, ACCENT_COOKIE_MAX_AGE)
    _setAccent(accent)
  }

  const resetAccent = () => {
    removeCookie(ACCENT_COOKIE_NAME)
    _setAccent(DEFAULT_ACCENT)
  }

  return (
    <AccentContext
      value={{
        defaultAccent: DEFAULT_ACCENT,
        accent,
        setAccent,
        resetAccent,
      }}
    >
      {children}
    </AccentContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAccent() {
  const context = useContext(AccentContext)
  if (!context) {
    throw new Error('useAccent must be used within an AccentProvider')
  }
  return context
}
