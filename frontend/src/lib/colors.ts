/** CSS の変数の値を読む (グラフの色に使う) */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 系列の色の変数名を固定の順で返す. 8 色を超える場合は呼び出し側で束ねる */
export function seriesVar(index: number): string {
  return `--series-${(index % 8) + 1}`
}
