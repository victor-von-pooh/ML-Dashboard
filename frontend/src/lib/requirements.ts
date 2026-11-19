import { CheckCircle2, CircleHelp, XCircle } from 'lucide-react'

/** 入っているかの表示. 色だけに頼らずアイコンと文字も付ける */
export function availability(available: boolean | null | undefined) {
  if (available === true)
    return { label: '入っている', icon: CheckCircle2, className: 'text-good-text bg-good/10' }
  if (available === false)
    return { label: '足りない', icon: XCircle, className: 'text-critical-text bg-critical/10' }
  return { label: '確かめられない', icon: CircleHelp, className: 'text-ink-2 bg-surface-2' }
}

/** 入れ方の URL は http か https のものだけをリンクにする (バックエンドでも確かめ済み) */
export function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//.test(url) ? url : null
}
