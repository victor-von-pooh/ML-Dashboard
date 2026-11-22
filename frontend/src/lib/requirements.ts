import { CheckCircle2, CircleArrowUp, CircleHelp, XCircle } from 'lucide-react'

import type { Requirement } from '../api/client'

type RequirementCheck = Requirement['checks'][number]

/** 入っているかの表示. 色だけに頼らずアイコンと文字も付ける. 版が古い時は「足りない」と分ける */
export function availability(available: boolean | null | undefined, old = false) {
  if (available === true)
    return { label: '入っている', icon: CheckCircle2, className: 'text-good-text bg-good/10' }
  if (available === false && old)
    return {
      label: '版が古い',
      icon: CircleArrowUp,
      className: 'text-critical-text bg-critical/10',
    }
  if (available === false)
    return { label: '足りない', icon: XCircle, className: 'text-critical-text bg-critical/10' }
  return { label: '確かめられない', icon: CircleHelp, className: 'text-ink-2 bg-surface-2' }
}

/**
 * 入っているが版が下限より古い確かめ方か (ok が false で, 入っている版と下限がある).
 * 版を書かない版の ML-Found の結果と, 版を読めない時 (ok が true) は false
 */
export function isOldCheck(check: RequirementCheck): boolean {
  return check.ok === false && check.version != null && check.min_version != null
}

/**
 * 足りない機能が, 入っていないのではなく版が古いだけか (バックエンドの is_old_version と同じ).
 * 全てが要る (all) 機能は満たしていない確かめ方が全て版の古いもの, どれか 1 つ (any) の機能は
 * 版の古いものが 1 つでもある場合
 */
export function isOldVersion(requirement: Requirement): boolean {
  if (requirement.available !== false) return false
  const old = requirement.checks.filter(isOldCheck)
  const failed = requirement.checks.filter((check) => check.ok === false)
  return old.length > 0 && (requirement.match === 'any' || old.length === failed.length)
}

/** 版の古い確かめ方の, 入っている版と下限 (「gymnasium 0.29.1, 1.0 以上が要る」) */
export function describeOldVersion(requirement: Requirement): string {
  return requirement.checks
    .filter(isOldCheck)
    .map((check) => `${check.name} ${check.version}, ${check.min_version} 以上が要る`)
    .join('; ')
}

/**
 * 起動の画面で, 足りない機能を入っていないものと版が古いものに分けた文.
 * summary は開始のボタンを押せない理由, title はカードの見出し, text は説明
 */
export function describeMissing(missing: Requirement[]): {
  summary: string
  title: string
  text: string
} {
  const absent = missing.filter((item) => !isOldVersion(item)).map((item) => item.name)
  const old = missing.filter(isOldVersion)
  const oldNames = old.map((item) => item.name).join(', ')
  // 括弧の中は「名前 版, 下限」だけ (機能の名前は括弧の前に 1 回だけ出す)
  const details = old.map(describeOldVersion).join('; ')
  if (old.length === 0) {
    return {
      summary: `${absent.join(', ')} が足りないので開始できません`,
      title: '足りない追加の依存があるので開始できません',
      text: 'config の requires に書いた機能が, プロジェクトの Python に入っていません.',
    }
  }
  if (absent.length === 0) {
    return {
      summary: `${oldNames} の版が古いので開始できません`,
      title: '版の古い追加の依存があるので開始できません',
      text: `config の requires に書いた機能のうち, ${oldNames} は入っている版が古いです (${details}).`,
    }
  }
  return {
    summary: `${absent.join(', ')} が足りず, ${oldNames} の版が古いので開始できません`,
    title: '足りないか版の古い追加の依存があるので開始できません',
    text: `config の requires に書いた機能のうち, ${absent.join(', ')} がプロジェクトの Python に入っておらず, ${oldNames} は入っている版が古いです (${details}).`,
  }
}

/** 入れ方の URL は http か https のものだけをリンクにする (バックエンドでも確かめ済み) */
export function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//.test(url) ? url : null
}

/**
 * 初めて使うときに大きなファイルを取る機能と, その注意 (ML-Found の登録簿の補足の要約).
 * 取る間は学習が止まったように見えるので, カードと学習の起動の前に知らせる
 */
const FIRST_USE_DOWNLOADS: Record<string, string> = {
  fid:
    '初めて使うときに, FID の特徴を取り出す Inception の学習済みの重み (約 91 MB) を ' +
    'GitHub から取ります. 取り終えるまで学習が止まったように見えます. ' +
    'ネットワークの無い計算機では先に取っておきます',
}

/** 機能の名前のうち, 初めて使うときに大きなファイルを取るものと, その注意 */
export function firstUseDownloads(names: string[]): { name: string; text: string }[] {
  return [...new Set(names)]
    .filter((name) => Object.hasOwn(FIRST_USE_DOWNLOADS, name))
    .map((name) => ({ name, text: FIRST_USE_DOWNLOADS[name]! }))
}
