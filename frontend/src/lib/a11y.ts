import { useId } from 'react'

/** 再描画しても変わらない ID (タブなどの結び付けに使う) */
export function useStableId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`
}
