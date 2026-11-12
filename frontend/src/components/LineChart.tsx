import { LineChart as ELineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cssVar } from '../lib/colors'
import { formatAxis, formatMetric } from '../lib/format'
import { useTheme } from '../lib/themeContext'

echarts.use([
  ELineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  CanvasRenderer,
])

export interface ChartSeries {
  name: string
  /** 色の CSS 変数名 (例: --series-1). 描画のときにテーマに合わせて読む */
  color: string
  points: [number, number | null][]
  dashed?: boolean
}

export interface ChartMarker {
  x: number
  label: string
}

interface Props {
  series: ChartSeries[]
  markers?: ChartMarker[]
  logScale?: boolean
  height?: number
  xLabel?: string
  /** 読み上げ用のグラフの説明 */
  label: string
}

// 毎回の描画で新しい配列にならないように, 既定値は共通の空の配列
const NO_MARKERS: ChartMarker[] = []

// 目印の線だけを持つ系列の名前 (凡例には出さない)
const MARKER_SERIES = '__markers__'

/** エポックごとの値の折れ線グラフ. Ctrl とホイールで拡大し, 全系列を並べるツールチップ付き */
export function LineChart({
  series,
  markers = NO_MARKERS,
  logScale = false,
  height = 260,
  xLabel,
  label,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const { theme } = useTheme()

  // グラフの作成と, 大きさの変化への追従
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chart.on('datazoom', () => {
      const option = chart.getOption() as { dataZoom?: { start?: number; end?: number }[] }
      const zoom = option.dataZoom?.[0]
      setZoomed((zoom?.start ?? 0) > 0 || (zoom?.end ?? 100) < 100)
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // データとテーマが変わったら描き直す. 拡大と凡例の選択は残す
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const ink2 = cssVar('--text-2')
    const ink3 = cssVar('--text-3')
    const grid = cssVar('--border')
    const surface = cssVar('--surface')
    const usable = logScale && series.every((s) => s.points.every(([, y]) => y == null || y > 0))
    const xs = series.flatMap((s) => s.points.map(([x]) => x))
    const legend = series.length > 1

    chart.setOption(
      {
        animation: false,
        grid: {
          left: 8,
          right: 20,
          // 目印のラベルを描く余白を上に確保
          top: (legend ? 40 : 20) + (markers.length > 0 ? 14 : 0),
          bottom: xLabel ? 36 : 24,
          containLabel: true,
        },
        legend: legend
          ? {
              show: true,
              type: 'scroll',
              top: 0,
              left: 0,
              right: 0,
              data: series.map((s) => s.name),
              pageIconColor: ink2,
              pageTextStyle: { color: ink3 },
              icon: 'roundRect',
              itemWidth: 12,
              itemHeight: 4,
              textStyle: { color: ink2, fontSize: 12 },
            }
          : {
              // 凡例を隠す場合は, 前に隠した系列も表示に戻す
              show: false,
              selected: Object.fromEntries(series.map((s) => [s.name, true])),
            },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: ink3 } },
          backgroundColor: surface,
          borderColor: grid,
          textStyle: { color: cssVar('--text'), fontSize: 12 },
          valueFormatter: (value: unknown) =>
            formatMetric(typeof value === 'number' ? value : null),
        },
        xAxis: {
          type: 'value',
          name: xLabel,
          nameLocation: 'middle',
          nameGap: 24,
          nameTextStyle: { color: ink3, fontSize: 11 },
          // 1 エポックだけの場合も点が端に寄らないように幅を確保
          min: (value: { min: number; max: number }) =>
            value.min === value.max ? value.min - 1 : value.min,
          max: (value: { min: number; max: number }) =>
            value.min === value.max ? value.max + 1 : value.max,
          minInterval: 1,
          axisLine: { lineStyle: { color: grid } },
          axisLabel: { color: ink3, fontSize: 11 },
          splitLine: { show: false },
        },
        yAxis: {
          type: usable ? 'log' : 'value',
          scale: true,
          axisLabel: {
            color: ink3,
            fontSize: 11,
            formatter: (value: number) => formatAxis(value),
          },
          splitLine: { lineStyle: { color: grid, opacity: 0.6 } },
        },
        // ページのスクロールを妨げないように, 拡大は Ctrl とホイール, ドラッグで移動
        dataZoom: [
          {
            type: 'inside',
            filterMode: 'none',
            zoomOnMouseWheel: 'ctrl',
            moveOnMouseWheel: false,
          },
        ],
        series: [
          ...series.map((s) => {
            const color = cssVar(s.color)
            return {
              type: 'line',
              name: s.name,
              data: s.points,
              showSymbol: s.points.length <= 1,
              symbolSize: 8,
              connectNulls: false,
              lineStyle: { width: 2, color, type: s.dashed ? 'dashed' : 'solid' },
              itemStyle: { color },
              emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
            }
          }),
          // 凡例で系列を隠しても目印が消えないように, 目印は専用の系列に置く
          {
            type: 'line',
            name: MARKER_SERIES,
            data: xs.length > 0 ? [[Math.min(...xs), null]] : [],
            silent: true,
            tooltip: { show: false },
            markLine: {
              symbol: 'none',
              silent: true,
              lineStyle: { color: ink3, type: 'dashed', width: 1 },
              label: { color: ink2, fontSize: 11, formatter: '{b}', position: 'end' },
              // 2 つ目以降の目印は線に沿わせて, 近いエポックでもラベルが重ならないようにする
              data: markers.map((m, index) => ({
                xAxis: m.x,
                name: m.label,
                label: index === 0 ? undefined : { position: 'insideEndTop' },
              })),
            },
          },
        ],
      },
      { replaceMerge: ['series'] },
    )
  }, [series, markers, logScale, xLabel, theme])

  const reset = () => {
    chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
    setZoomed(false)
  }

  return (
    <div className="relative">
      <div ref={ref} style={{ height }} className="w-full" role="img" aria-label={label} />
      {zoomed && (
        <button
          type="button"
          onClick={reset}
          className="absolute right-1 bottom-1 inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-2"
        >
          <RotateCcw className="size-3" aria-hidden />
          拡大を戻す
        </button>
      )}
    </div>
  )
}
