import type { RunModel } from '../api/client'

// 定義の記録が無い実験の組の鍵
const NO_MODEL = 'none'

// 表示の名前に添える sha256 の長さ
const SHORT_SHA = 8

/** 比較で実験を分ける組の鍵. 元の場所と sha256 (名前は表示だけに使う) */
export function modelKey(model: RunModel | null | undefined): string {
  if (!model) return NO_MODEL
  if (!model.origin_known) return `copy\n${model.sha256 ?? ''}`
  return `${model.path}\n${model.sha256 ?? ''}`
}

/** 組の表示の名前の元 (同じ名前の組を見分ける前) */
function baseLabel(model: RunModel | null | undefined): string {
  if (!model) return '定義の記録が無い'
  if (!model.origin_known) return '写し'
  if (!model.sha256) return `${model.name} (中身が分からない)`
  return model.name
}

/**
 * 組の鍵から表示の名前. 同じ名前の組が 2 つ以上あれば, 場所か sha256 の先頭 8 文字を添えて
 * 見分ける (違いの無い組は名前だけ)
 */
export function modelLabels(models: (RunModel | null | undefined)[]): Map<string, string> {
  const byKey = new Map<string, RunModel | null | undefined>()
  for (const model of models) byKey.set(modelKey(model), model)
  const byLabel = new Map<string, string[]>()
  for (const [key, model] of byKey) {
    const label = baseLabel(model)
    byLabel.set(label, [...(byLabel.get(label) ?? []), key])
  }
  const labels = new Map<string, string>()
  for (const [label, keys] of byLabel) {
    if (keys.length === 1) {
      labels.set(keys[0] ?? '', label)
      continue
    }
    const group = keys.map((key) => byKey.get(key))
    const paths = new Set(group.map((model) => model?.path ?? ''))
    for (const key of keys) {
      const model = byKey.get(key)
      const extras: string[] = []
      if (paths.size > 1 && model?.path) extras.push(model.path)
      if (model?.sha256) extras.push(model.sha256.slice(0, SHORT_SHA))
      labels.set(key, extras.length > 0 ? `${label} (${extras.join(', ')})` : label)
    }
  }
  return labels
}

/** 実験を組ごとにまとめる (組は初めに出た順, 組の中は元の順) */
export function groupByModel<T>(
  items: T[],
  modelOf: (item: T) => RunModel | null | undefined,
): { key: string; label: string; items: T[] }[] {
  const labels = modelLabels(items.map(modelOf))
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = modelKey(modelOf(item))
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups].map(([key, members]) => ({
    key,
    label: labels.get(key) ?? key,
    items: members,
  }))
}
