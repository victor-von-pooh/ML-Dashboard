import { useId } from 'react'

/** Tabs の中身に付ける属性 */
export function tabPanelProps(idBase: string, value: string) {
  return {
    id: `${idBase}-panel`,
    role: 'tabpanel',
    'aria-labelledby': `${idBase}-tab-${value}`,
  } as const
}

/** 再描画しても変わらない ID (タブなどの結び付けに使う) */
export function useStableId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`
}
