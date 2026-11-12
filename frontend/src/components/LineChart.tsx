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
import { useEffect, useRef } from 'react'

import { formatMetric } from '../lib/format'
import { cssVar } from '../lib/colors'
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
}

/** エポックごとの値の折れ線グラフ. 拡大と, 全系列を並べるツールチップ付き */
export function LineChart({ series, markers = [], logScale = false, height = 260, xLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const { theme } = useTheme()

  // グラフの作成と, 大きさの変化への追従
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // データとテーマが変わったら描き直す
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const ink2 = cssVar('--text-2')
    const ink3 = cssVar('--text-3')
    const grid = cssVar('--border')
    const surface = cssVar('--surface')
    const usable = logScale && series.every((s) => s.points.every(([, y]) => y == null || y > 0))

    chart.setOption(
      {
        animation: false,
        grid: {
          left: 8,
          right: 20,
          top: series.length > 1 ? 40 : 16,
          bottom: xLabel ? 36 : 24,
          containLabel: true,
        },
        legend:
          series.length > 1
            ? {
                type: 'scroll',
                top: 0,
                left: 0,
                right: 0,
                pageIconColor: ink2,
                pageTextStyle: { color: ink3 },
                icon: 'roundRect',
                itemWidth: 12,
                itemHeight: 4,
                textStyle: { color: ink2, fontSize: 12 },
              }
            : undefined,
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
          min: 'dataMin',
          max: 'dataMax',
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
            formatter: (value: number) => formatMetric(value),
          },
          splitLine: { lineStyle: { color: grid, opacity: 0.6 } },
        },
        dataZoom: [{ type: 'inside', filterMode: 'none' }],
        series: series.map((s, index) => {
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
            markLine:
              index === 0 && markers.length > 0
                ? {
                    symbol: 'none',
                    silent: true,
                    lineStyle: { color: ink3, type: 'dashed', width: 1 },
                    label: { color: ink2, fontSize: 11, formatter: '{b}' },
                    data: markers.map((m) => ({ xAxis: m.x, name: m.label })),
                  }
                : undefined,
          }
        }),
      },
      true,
    )
  }, [series, markers, logScale, xLabel, theme])

  return <div ref={ref} style={{ height }} className="w-full" role="img" />
}
