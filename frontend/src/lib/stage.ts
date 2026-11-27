import { createContext, useContext } from 'react'

/** 根の部品が受け取った, 殻とのやり取り (単独では選びを持たず, 知らせはどこにも届かない) */
export interface StageValue {
  /** 殻で選んだ問題の設定の識別子 (null は選んでいない) */
  project: string | null
  /** 置き場の問題の設定に記録されたプロジェクトを登録したときに, その識別子で呼ぶ */
  onProjectChange: (project: string | null) => void
  /** 殻の下に載せたか (アプリの名前と明暗の切り替えを出さない) */
  embedded: boolean
}

export const StageContext = createContext<StageValue>({
  project: null,
  onProjectChange: () => {},
  embedded: false,
})

/** 根の部品が受け取った, 殻とのやり取りを使う */
export function useStage(): StageValue {
  return useContext(StageContext)
}

/**
 * problem.yaml の場所から, 問題の設定の識別子 (親のディレクトリの名前) を取る
 *
 * @param path - problem.yaml の場所 (区切りは `/` か `\`)
 */
export function problemIdOf(path: string): string | null {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null
}

/**
 * キーの押された所が部品の外 (殻の上の帯など) かを返す
 *
 * 部品の範囲は根の部品が付ける `data-stage-root` の中. どこにも focus が無い (body) ときは
 * 部品の中として扱う
 *
 * @param target - キーの event の target
 */
export function outsideStage(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target === document.body || target === document.documentElement) return false
  return target.closest('[data-stage-root]') === null
}
