import { createContext, useContext } from 'react'

export type Theme = 'light' | 'dark'

export interface ThemeValue {
  theme: Theme
  toggle: () => void
}

export const ThemeContext = createContext<ThemeValue | null>(null)

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('ThemeProvider の外で useTheme は使えません')
  return value
}
