import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

import { ThemeContext, type Theme } from './themeContext'

/** 今のテーマ (html のクラス. 単独では index.html が描画の前に決める) を読む */
function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * 明暗を html のクラス `dark` と localStorage の `theme` で持つ
 *
 * readOnly (殻の下) では書き換えず, html のクラスの変化を見て読み直す (殻の切り替えが,
 * 色の変数を読んで描くグラフなどにも効くように)
 */
export function ThemeProvider({
  readOnly = false,
  children,
}: {
  readOnly?: boolean
  children: ReactNode
}) {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  // 描画の前に html のクラスを切り替え, グラフが新しい色を読めるようにする
  useLayoutEffect(() => {
    if (readOnly) return
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme, readOnly])

  // 殻の下では, 殻が html のクラスを替えたら読み直す
  useEffect(() => {
    if (!readOnly) return
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [readOnly])

  const toggle = useCallback(() => {
    if (readOnly) return
    setTheme((previous) => {
      const next: Theme = previous === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem('theme', next)
      } catch {
        // 保存できない環境でも切り替え自体は行う
      }
      return next
    })
  }, [readOnly])

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
