import type { BestValue, History } from '../api/client'

/** 比べられる実験の数の上限 (グラフの系列の色の数) */
export const MAX_COMPARE = 8

/** 1 つのグラフにまとめる指標 (例: train/loss, train_eval/loss, valid/loss を loss に) */
export interface MetricGroup {
  name: string
  keys: string[]
}

// train_eval は, 学習用データを推論モードで評価し直した値 (ML-Found の trainer.eval_train)
const PHASES = ['train', 'train_eval', 'valid']

/** 学習用データの指標 (学習中の値と, 推論モードで評価し直した値) の接頭辞 */
export const TRAIN_PREFIXES = ['train/', 'train_eval/']

/** history.csv の列を, 学習用と検証用を重ねる指標ごとにまとめる */
export function groupMetrics(columns: string[]): MetricGroup[] {
  const groups = new Map<string, string[]>()
  for (const column of columns) {
    if (column === 'epoch') continue
    const [phase, ...rest] = column.split('/')
    const name = phase && PHASES.includes(phase) && rest.length > 0 ? rest.join('/') : column
    groups.set(name, [...(groups.get(name) ?? []), column])
  }

  // 損失を先頭に, 学習率などの学習用と検証用に分かれない値を末尾に
  const entries = [...groups.entries()].map(([name, keys]) => ({ name, keys }))
  const rank = (group: MetricGroup) => {
    if (group.name === 'loss') return 0
    if (group.keys.every((key) => !key.includes('/'))) return 2
    return 1
  }
  return entries.sort((a, b) => rank(a) - rank(b))
}

/** 入れ子の config を「trainer.epochs」の形の平らな辞書にする */
export function flattenConfig(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? { [prefix]: value } : {}
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return prefix ? { [prefix]: {} } : {}
  return Object.assign(
    {},
    ...entries.map(([key, child]) => flattenConfig(child, prefix ? `${prefix}.${key}` : key)),
  ) as Record<string, unknown>
}

/** 複数の config で値が違う項目を取り出す */
export function diffConfigs(configs: Record<string, unknown>[]): string[] {
  const flat = configs.map((config) => flattenConfig(config))
  const keys = new Set(flat.flatMap((item) => Object.keys(item)))
  return [...keys]
    .filter((key) => {
      const values = flat.map((item) => JSON.stringify(item[key] ?? null))
      return new Set(values).size > 1
    })
    .sort()
}

/** 実験の config の差分を「trainer.epochs=10」の短い文字列の一覧にする */
export function summarizeDiff(diff: Record<string, unknown>): string[] {
  return Object.entries(diff).map(([key, value]) => {
    const experiment =
      value && typeof value === 'object' && 'experiment' in value
        ? (value as { experiment: unknown }).experiment
        : value
    const shown = typeof experiment === 'string' ? experiment : JSON.stringify(experiment)
    return `${key}=${shown}`
  })
}

/** 学習曲線の既定の横軸 (history.csv の epoch. 無い記録では行の番号) */
export const EPOCH_AXIS = 'epoch'

/**
 * 列の値を横軸の値との組にする. 横軸は既定でエポック, 他の列 (環境のステップ数など)
 * を選んだ場合は, その列の値の無い行を除く
 */
export function toPoints(
  history: History,
  key: string,
  x: string = EPOCH_AXIS,
): [number, number | null][] {
  if (x === EPOCH_AXIS) {
    return history.rows.map((row, index) => [row.epoch ?? index + 1, row[key] ?? null])
  }
  return history.rows.flatMap<[number, number | null]>((row) => {
    const position = row[x]
    return position == null ? [] : [[position, row[key] ?? null]]
  })
}

/**
 * 実験が横軸に使える列か. エポックは全ての実験で使え, 他の列はバックエンドが
 * 横軸の候補 (エポックごとに増え続ける列) とした場合だけ
 */
export function hasAxis(history: History, x: string): boolean {
  return x === EPOCH_AXIS || (history.x_columns ?? []).includes(x)
}

/** 実験の横軸の候補を, エポックを先頭に重ねずに並べる */
export function axisOptions(histories: History[]): string[] {
  const options = histories.flatMap((history) => history.x_columns ?? [])
  return [...new Set([EPOCH_AXIS, ...options])]
}

/** エポックの位置を, 選んだ横軸の上の位置にする (目印のため). 無ければ null */
export function axisAt(history: History, x: string, epoch: number): number | null {
  if (x === EPOCH_AXIS) return epoch
  // 再開で同じエポックの行が重なる場合は, 最後の (使われた) 行
  const row = history.rows.findLast((item) => item.epoch === epoch)
  return row?.[x] ?? null
}

/** 横軸の選択肢の表示名 (エポックは日本語, 他の列は列の名前のまま) */
export function axisLabel(x: string): string {
  return x === EPOCH_AXIS ? 'エポック' : x
}

/**
 * 横軸の左端. エポック以外の列 (環境のステップ数など) は, 値が全て 0 以上なら 0 から描く
 * (学習を始めた時点からの進み具合として読むため). それ以外は undefined (最初の値)
 */
export function axisStart(histories: History[], x: string): number | undefined {
  if (x === EPOCH_AXIS) return undefined
  const nonNegative = histories.every((history) =>
    history.rows.every((row) => row[x] == null || row[x] >= 0),
  )
  return nonNegative ? 0 : undefined
}

/** 横軸の値が全て整数か (目盛りを整数に限るため) */
export function integerAxis(histories: History[], x: string): boolean {
  if (x === EPOCH_AXIS) return true
  return histories.every((history) =>
    history.rows.every((row) => row[x] == null || Number.isInteger(row[x])),
  )
}

/** 2 つの系列の全ての点 (エポックと値) が同じかどうか */
function samePoints(a: [number, number | null][], b: [number, number | null][]): boolean {
  if (a.length !== b.length) return false
  return a.every(([x, y], index) => x === b[index]![0] && y === b[index]![1])
}

/**
 * 全ての点が同じ値の系列 (グラフで線が完全に重なり, 下の線が見えないもの) を,
 * 名前の組にまとめて返す. 値の無い点だけの系列は対象外
 */
export function identicalSeries(
  series: { name: string; points: [number, number | null][] }[],
): string[][] {
  const groups: { points: [number, number | null][]; names: string[] }[] = []
  for (const item of series) {
    if (!item.points.some(([, value]) => value != null)) continue
    const group = groups.find((candidate) => samePoints(candidate.points, item.points))
    if (group) group.names.push(item.name)
    else groups.push({ points: item.points, names: [item.name] })
  }
  return groups.filter((group) => group.names.length > 1).map((group) => group.names)
}

/** 系列の点の描き方 (孤立した点の記号と, 値の無い点を飛ばしてつなぐか) */
export interface PointStyle {
  /** 前後の点がどちらも値を持たない, 値のある点 (線を引けないので記号で描く) の位置 */
  isolated: Set<number>
  /** 値のある点が 2 つ以上で全て孤立した系列 (何エポックかおきに記録する指標) */
  sparse: boolean
}

/** 値の無い点で途切れる線では見えない点を探し, 系列の描き方を決める */
export function pointStyle(points: [number, number | null][]): PointStyle {
  const has = (index: number) => points[index] !== undefined && points[index]![1] != null
  const isolated = new Set<number>()
  let valued = 0
  points.forEach((_, index) => {
    if (!has(index)) return
    valued += 1
    if (!has(index - 1) && !has(index + 1)) isolated.add(index)
  })
  return { isolated, sparse: valued >= 2 && isolated.size === valued }
}

/** config の ML-Found の検証の間隔 (trainer.valid_every_n_epochs. 無いか読めなければ 1) */
export function validInterval(config: Record<string, unknown> | null | undefined): number {
  const trainer = config?.trainer
  const value =
    trainer && typeof trainer === 'object'
      ? (trainer as Record<string, unknown>).valid_every_n_epochs
      : undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : 1
}

/**
 * 検証の間隔を空けた実験で, 検証したエポックだけに値のある指標か (valid/ と train_eval/).
 * 値の無いエポックを飛ばしてつなぎ, 記録した点に記号を付ける
 */
export function judgedOnly(key: string, interval: number): boolean {
  return interval > 1 && (key.startsWith('valid/') || key.startsWith('train_eval/'))
}

/** 指標の良い向き (大きいほど良いか, 小さいほど良いか) */
export type Direction = 'max' | 'min'

// 名前から向きを推測する指標 (小さいほど良いものを先に判定)
const LOWER_IS_BETTER = /loss|err|mae|mse|rmse|nelbo|kl|recon|residual|boundary|perplexity|time/i
// 語として現れる場合だけ小さいほど良い指標. 部分一致では confidence や fidelity まで
// 小さいほど良いと取り違えるため. fid は生成の画像の FID. chamfer は点群の Chamfer 距離.
// distance は距離 (例えば作った表と本物の表の列ごとの分布の近さ column_distance)
const LOWER_WORDS = /(^|[/_.-])(fid|chamfer|distance)($|[/_.-])/i
// ndcg と mrr は並べる課題の指標 (recall_at_k は recall で大きいほど良い). silhouette
// は群分けのシルエット係数. qini は効果を見積もるの Qini の係数
const HIGHER_IS_BETTER =
  /acc|auc|^ap$|\/ap$|f1|precision|recall|r2|score|iou|psnr|ssim|ndcg|mrr|silhouette|qini/i
// 語として現れる場合だけ大きいほど良い指標. ari は群分けの調整ランド指数 (部分一致では
// variance まで含むため)
const HIGHER_WORDS = /(^|[/_.-])ari($|[/_.-])/i

/** 指標の名前から良い向きを推測する. 分からなければ null */
export function guessDirection(name: string): Direction | null {
  if (LOWER_IS_BETTER.test(name) || LOWER_WORDS.test(name)) return 'min'
  if (HIGHER_IS_BETTER.test(name) || HIGHER_WORDS.test(name)) return 'max'
  return null
}

/** 列の良い向きと, 名前から推測したか */
export interface ColumnDirection {
  direction: Direction
  guessed: boolean
}

/**
 * history.csv の列の良い向き. 監視する指標は ML-Found の向き (trainer.mode. 比べる
 * 実験で向きが食い違う場合は推測に任せる), その他は名前から推測する. 学習率の列と,
 * 推測できない列は null
 */
export function columnDirection(
  key: string,
  bests: (Pick<BestValue, 'monitor' | 'mode'> | null | undefined)[] = [],
): ColumnDirection | null {
  const modes = new Set(bests.filter((best) => best?.monitor === key).map((best) => best!.mode))
  const [mode] = modes
  if (modes.size === 1 && mode) return { direction: mode, guessed: false }
  if (key === 'lr' || key.startsWith('lr_')) return null
  const direction = guessDirection(key)
  return direction ? { direction, guessed: true } : null
}

/** 良い向きの表示 */
export function directionLabel(direction: Direction): string {
  return direction === 'max' ? '大きいほど良い' : '小さいほど良い'
}

// 指標の名前 (最後の / の後) の日本語の名前と, 添える説明
const METRIC_LABELS: Record<string, MetricLabel> = {
  ari: { label: '調整ランド指数の平均', note: '作り直した群との一致. 1 は同じ群, 0 は偶然と同じ' },
  ari_min: { label: '調整ランド指数の最小', note: '作り直した群との一致の最も低い値' },
  silhouette: { label: 'シルエット係数', note: '群のまとまり. -1 から 1' },
  precision_at_k: {
    label: '上位 K 件の適合率',
    note: '値の高い順の上位 K 件のうち, 当たり (異常の行など) の割合',
  },
  average_precision: {
    label: 'PR-AUC',
    note: '値の高い順に並べた適合率と再現率の曲線の下の面積 (平均適合率)',
  },
  qini: {
    label: 'Qini の係数',
    note: '効果の見積もりの高い順の並びの良さ. 1 は理想の並び, 0 はでたらめに配るのと同じ',
  },
  uplift_at_k: {
    label: '上位 K 割の効果の差',
    note: '効果の見積もりの高い順の上位 K 割の行での, 処置の群と対照の群の結果の平均の差',
  },
}
// 比べる相手の列の終わりと, 日本語の名前に添える言葉
const COMPARE_SUFFIXES: [string, string][] = [
  ['_baseline', '比べる相手の値'],
  ['_diff', '比べる相手との差'],
]
// 評価ごとの列の日本語の名前 (群の数や行の数のように, 同じ名前が評価で別の意味になる列)
const EVALUATION_LABELS: Record<string, Record<string, MetricLabel>> = {
  group_stability: {
    k: { label: '群の数', note: null },
    method: { label: '作り直し方', note: 'seed は種を変え, sample は標本を変える' },
    repeats: { label: '作り直した回数', note: null },
  },
  group_summary: {
    group: { label: '群', note: '群の番号. 全体は全ての行' },
    rows: { label: '行の数', note: null },
    share: { label: '割合', note: '全ての行に対する行の割合' },
    stability: {
      label: '安定性',
      note: '作り直した群のうち最も重なる群との Jaccard 係数の平均',
    },
  },
}

// 異常の検知 (ML-Quest の異常の検知の骨組み) の評価の列の日本語の名前. 名前の後ろの
// 分割は _ を含まない名前 (anomaly_scores_test を anomaly_<分割> と取り違えないため)
const ANOMALY_SCORE: MetricLabel = {
  label: '異常の度合い',
  note: '大きいほど学習用の正常の行から外れている',
}
const ANOMALY_EVALUATIONS: [RegExp, string, Record<string, MetricLabel>][] = [
  [
    /^anomaly_scores_[^_]+$/,
    '度合いの分布',
    {
      quantile: { label: '分位', note: '0 から 1. 0.95 は度合いの低い方から 95 % の位置' },
      score: ANOMALY_SCORE,
    },
  ],
  [
    /^anomaly_top_[^_]+$/,
    '上位の行の要約',
    {
      rank: { label: '順位', note: '度合いの高い順' },
      score: ANOMALY_SCORE,
      column: { label: '最も外れた列', note: '度合いのうち最も大きい分の列' },
      column_share: {
        label: 'その列が占める割合',
        note: '度合いのうち最も外れた列が占める割合. 0 から 1',
      },
    },
  ],
  [
    /^anomaly_[^_]+$/,
    '上位 K 件の適合率と PR-AUC',
    {
      rows: { label: '行の数', note: null },
      anomalies: { label: '異常の行の数', note: '正解で異常の行' },
      k: { label: '上位の件数 K', note: '上位 K 件の適合率の K' },
      precision_at_k: {
        label: '上位 K 件の適合率',
        note: '度合いの高い K 行のうち異常の行の割合. 異常の割合が小さいと低く出る',
      },
      average_precision: {
        label: 'PR-AUC',
        note: '度合いの順に並べた適合率と再現率の曲線の下の面積. 異常の行を上位に並べられているほど 1 に近く, でたらめな順では異常の割合',
      },
    },
  ],
]

// 効果を見積もる (ML-Quest の効果の見積もりの骨組み) の評価の列の日本語の名前. 名前の
// 後ろの分割は異常の検知と同じく _ を含まない名前
const UPLIFT_EVALUATIONS: [RegExp, string, Record<string, MetricLabel>][] = [
  [
    /^qini_curve_[^_]+$/,
    'Qini の曲線',
    {
      rows: { label: '上位の行の数', note: '効果の見積もりの高い順の上位の行の数' },
      fraction: { label: '上位の行の割合', note: '0 から 1. 0.3 は上位 30 %' },
      qini: {
        label: 'Qini の値',
        note: '上位の行で処置によって増えた結果 (対照の群の数を処置の群に合わせた結果の和の差)',
      },
      random: {
        label: 'でたらめに配る線',
        note: '効果の見積もりを使わずに無作為に配った場合の直線',
      },
    },
  ],
  [
    /^uplift_[^_]+$/,
    'Qini の係数と上位 K 割の効果の差',
    {
      rows: { label: '行の数', note: null },
      treated: { label: '処置の群の行の数', note: '処置した (クーポンを配った) 行' },
      control: { label: '対照の群の行の数', note: '処置しなかった行' },
      k: { label: '上位の割合 K', note: '0 から 1. 0.3 は上位 30 %' },
      qini: {
        label: 'Qini の係数',
        note: '効果の見積もりの高い順の並びの良さ. 1 は理想の並び, 0 はでたらめに配るのと同じ, 負はでたらめより悪い',
      },
      uplift_at_k: {
        label: '上位 K 割の効果の差',
        note: '効果の見積もりの高い順の上位 K 割の行での, 処置の群と対照の群の結果の平均の差. 上位に片方の群が無ければ「—」',
      },
      effect: {
        label: '全体の効果の差',
        note: '分割の全ての行での, 処置の群と対照の群の結果の平均の差 (無作為に配った場合の効果)',
      },
      estimated: { label: '効果の見積もりの平均', note: '分割の全ての行の効果の見積もりの平均' },
    },
  ],
]

// 値段を変える判断 (ML-Quest の値段を変える判断の骨組み) の評価の列の日本語の名前. 名前の
// 後ろの分割は異常の検知と同じく _ を含まない名前
const PRICE_EVALUATIONS: [RegExp, string, Record<string, MetricLabel>][] = [
  [
    /^price_[^_]+$/,
    '売れた数の予測の誤差と見込みの利益',
    {
      rows: { label: '行の数', note: null },
      products: { label: '商品の数', note: '値段を選ぶ商品の数. 商品の id の列が無ければ行の数' },
      mae: {
        label: '売れた数の平均絶対誤差',
        note: '記録の値段での売れた数の予測と記録の差の絶対値の平均 (売れた数の単位)',
      },
      rmse: {
        label: '売れた数の二乗平均平方根誤差',
        note: '記録の値段での売れた数の予測と記録の差の二乗の平均の平方根. 大きく外れた予測を重く数える',
      },
      elasticity: {
        label: '値段の弾力性の平均',
        note: '今の値段を 1 % 上げたときに予測した数が何 % 変わるかの商品の平均. -2 は 2 % 減る. 良し悪しの向きは無い',
      },
      elasticity_counted: {
        label: '弾力性を数えた商品の数',
        note: '今の値段での予測した数が 0 の商品は数えない',
      },
      profit: {
        label: '選んだ値段での見込みの利益',
        note: '商品ごとの 1 行あたりの見込みの利益 ((値段 − 原価) × 予測した数) の和',
      },
      current_profit: {
        label: '今の値段での見込みの利益',
        note: '今の値段での, 商品ごとの 1 行あたりの見込みの利益の和',
      },
      profit_gain: {
        label: '見込みの利益の差',
        note: '選んだ値段での見込みの利益から今の値段での見込みの利益を引いた値. 0 以上',
      },
      profit_ratio: {
        label: '見込みの利益の比',
        note: '選んだ値段での見込みの利益を今の値段での見込みの利益で割った値. 100 % は変わらない. 今の利益が 0 以下なら「—」',
      },
      changed: { label: '値段を変える商品の数', note: '選んだ変える割合が 0 % でない商品の数' },
      max_change: {
        label: '値段を変える幅の上限',
        note: '変える割合の絶対値の上限 (守る指標). 超える候補は選ばない',
      },
    },
  ],
]

// 時間をまたぐ量の判断 (ML-Quest の時間をまたぐ量の判断の骨組み) の評価の列の日本語の名前.
// 名前の後ろの分割は _ を含まない名前 (demand_levels_<分割> は demand_<分割> の形に当たらない)
const DEMAND_EVALUATIONS: [RegExp, string, Record<string, MetricLabel>][] = [
  [
    /^demand_levels_[^_]+$/,
    '水準ごとの分位点の損失',
    {
      level: {
        label: '水準',
        note: '学んだ分位点の水準. 0.9 は需要がこの数を超えない見込みが 90 %',
      },
      loss: {
        label: '分位点の損失',
        note: 'この水準の分位点の予測と先の期間の需要の分位点の損失 (pinball loss) の行の平均',
      },
    },
  ],
  [
    /^demand_[^_]+$/,
    '需要の予測の誤差と発注の数の損',
    {
      rows: { label: '行の数', note: '発注を決める日の行 (商品と日) の数' },
      products: { label: '商品の数', note: null },
      mae: {
        label: '需要の平均絶対誤差',
        note: '0.5 の分位点の予測と先の期間の需要の差の絶対値の平均 (需要の単位)',
      },
      pinball_loss: {
        label: '分位点の損失の平均',
        note: '学んだ全ての水準の分位点の損失 (pinball loss) の平均. 水準ごとの値は demand_levels の表',
      },
      order_cost: {
        label: '選んだ発注の数での損',
        note: '水準 τ の分位点から在庫を引いた発注の数での, 実際の需要での損の和 (品切れの損 × 足りない数 + 売れ残りの損 × 余った数)',
      },
      baseline_cost: {
        label: '前の期間と同じ数の発注での損',
        note: '前の期間の需要と同じ数 (在庫を引いた数) を発注したときの, 実際の需要での損の和',
      },
      order_cost_saving: {
        label: '発注の数の損の差',
        note: '前の期間と同じ数の発注での損から, 選んだ発注の数での損を引いた値. 0 より大きければ損が減る',
      },
      order_cost_ratio: {
        label: '発注の数の損の比',
        note: '選んだ発注の数での損を前の期間と同じ数の発注での損で割った値. 100 % は変わらない. 前の期間の損が 0 なら「—」',
      },
      capped: {
        label: '上限に当たった行の数',
        note: '発注の数の上限 (守る指標) を超える数を上限で切った行の数',
      },
      level: {
        label: '発注に使う水準 τ',
        note: '品切れの損 / (品切れの損 + 売れ残りの損)',
      },
      max_order: { label: '発注の数の上限', note: '1 回の発注の数の上限 (守る指標)' },
    },
  ],
]

/** 時間をまたぐ量の判断の評価の名前か (demand_<分割>, demand_levels_<分割>) */
export function isDemandEvaluation(evaluation: string): boolean {
  return DEMAND_EVALUATIONS.some(([pattern]) => pattern.test(evaluation))
}

/** 値段を変える判断の評価の名前か (price_<分割>) */
export function isPriceEvaluation(evaluation: string): boolean {
  return PRICE_EVALUATIONS.some(([pattern]) => pattern.test(evaluation))
}

/** 効果を見積もるの評価の名前か (uplift_<分割>, qini_curve_<分割>) */
export function isUpliftEvaluation(evaluation: string): boolean {
  return UPLIFT_EVALUATIONS.some(([pattern]) => pattern.test(evaluation))
}

/** 曲線に描く列 (名前の分かる評価で, 横軸と目盛りの違う列を除くもの). 知らない評価は null */
export function curveColumns(evaluation: string): string[] | null {
  return /^qini_curve_[^_]+$/.test(evaluation) ? ['qini', 'random'] : null
}

/** 異常の検知の評価の名前か (anomaly_<分割>, anomaly_scores_<分割>, anomaly_top_<分割>) */
export function isAnomalyEvaluation(evaluation: string): boolean {
  return ANOMALY_EVALUATIONS.some(([pattern]) => pattern.test(evaluation))
}

// 名前の形で引く評価 (異常の検知, 効果を見積もる, 値段を変える判断, 時間をまたぐ量の判断)
const PATTERN_EVALUATIONS = [
  ...ANOMALY_EVALUATIONS,
  ...UPLIFT_EVALUATIONS,
  ...PRICE_EVALUATIONS,
  ...DEMAND_EVALUATIONS,
]

/**
 * 名前の分かる評価の日本語の名前 (異常の検知, 効果を見積もる, 値段を変える判断, 時間を
 * またぐ量の判断の評価). 知らない評価は null
 */
export function evaluationTitle(evaluation: string): string | null {
  return PATTERN_EVALUATIONS.find(([pattern]) => pattern.test(evaluation))?.[1] ?? null
}

/** 評価に固有の列の日本語の名前 (名前で引く評価の次に, 名前の形で引く評価) */
function evaluationLabels(evaluation: string): Record<string, MetricLabel> | undefined {
  if (Object.hasOwn(EVALUATION_LABELS, evaluation)) return EVALUATION_LABELS[evaluation]
  return PATTERN_EVALUATIONS.find(([pattern]) => pattern.test(evaluation))?.[2]
}

/** 指標か評価の列の日本語の名前と, 添える説明 (無ければ null) */
export interface MetricLabel {
  label: string
  note: string | null
}

/**
 * 指標か評価の列の名前の日本語の名前. 評価の名前を渡すと, その評価に固有の列も引く.
 * <指標>_baseline と <指標>_diff は指標の名前に「比べる相手の値」などを添える.
 * 知らない名前は null
 */
export function metricLabel(name: string, evaluation?: string): MetricLabel | null {
  const metric = name.slice(name.lastIndexOf('/') + 1)
  const own = evaluation ? evaluationLabels(evaluation) : undefined
  if (own && Object.hasOwn(own, metric)) return own[metric] ?? null
  if (Object.hasOwn(METRIC_LABELS, metric)) return METRIC_LABELS[metric] ?? null
  for (const [suffix, word] of COMPARE_SUFFIXES) {
    const base = metric.slice(0, -suffix.length)
    if (metric.endsWith(suffix) && Object.hasOwn(METRIC_LABELS, base)) {
      return { label: `${METRIC_LABELS[base]!.label} (${word})`, note: null }
    }
  }
  return null
}

/** 日本語の名前と説明を 1 つの文にする (グラフの見出しに添える). 知らない名前は null */
export function metricNote(name: string, evaluation?: string): string | null {
  const found = metricLabel(name, evaluation)
  if (!found) return null
  return found.note ? `${found.label} (${found.note})` : found.label
}
