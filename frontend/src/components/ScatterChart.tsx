import { ScatterChart as EScatterChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

import { cssVar } from '../lib/colors'
import { formatAxis, formatMetric } from '../lib/format'
import { useTheme } from '../lib/themeContext'

echarts.use([EScatterChart, GridComponent, TooltipComponent, CanvasRenderer])

export interface ScatterPoint {
  id: string
  x: number | string
  y: number
}

interface Props {
  points: ScatterPoint[]
  /** 数値の軸か, 値の名前を並べる軸か */
  categories: string[] | null
  xLabel: string
  yLabel: string
  logX?: boolean
  logY?: boolean
  /** 目立たせる点 (最良の実験など) */
  highlight?: string | null
  onSelect?: (id: string) => void
  label: string
}

/** 1 つの config の項目と結果の関係を, 実験ごとの点で表す散布図 */
export function ScatterChart({
  points,
  categories,
  xLabel,
  yLabel,
  logX = false,
  logY = false,
  highlight = null,
  onSelect,
  label,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const selectRef = useRef(onSelect)
  const { theme } = useTheme()

  // 最新の選択の処理を保持 (グラフを作り直さずに差し替え)
  useEffect(() => {
    selectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chart.on('click', (event) => {
      const data = event.data as { id?: string } | undefined
      if (data?.id) selectRef.current?.(data.id)
    })
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const ink2 = cssVar('--text-2')
    const ink3 = cssVar('--text-3')
    const grid = cssVar('--border')
    const surface = cssVar('--surface')
    const accent = cssVar('--series-1')
    const best = cssVar('--series-2')
    const positiveX = points.every((point) => typeof point.x !== 'number' || point.x > 0)
    const positiveY = points.every((point) => point.y > 0)

    chart.setOption(
      {
        animation: false,
        grid: { left: 12, right: 24, top: 24, bottom: 40, containLabel: true },
        tooltip: {
          trigger: 'item',
          backgroundColor: surface,
          borderColor: grid,
          textStyle: { color: cssVar('--text'), fontSize: 12 },
          formatter: (params: { data: { id: string; value: [number | string, number] } }) => {
            const [x, y] = params.data.value
            return `${params.data.id}<br/>${xLabel}: ${typeof x === 'number' ? formatAxis(x) : x}<br/>${yLabel}: ${formatMetric(y)}`
          },
        },
        xAxis: {
          type: categories ? 'category' : logX && positiveX ? 'log' : 'value',
          data: categories ?? undefined,
          name: xLabel,
          nameLocation: 'middle',
          nameGap: 26,
          nameTextStyle: { color: ink3, fontSize: 11 },
          scale: true,
          axisLine: { lineStyle: { color: grid } },
          axisLabel: {
            color: ink3,
            fontSize: 11,
            formatter: categories ? undefined : (value: number) => formatAxis(value),
          },
          splitLine: { show: !categories, lineStyle: { color: grid, opacity: 0.6 } },
        },
        yAxis: {
          type: logY && positiveY ? 'log' : 'value',
          scale: true,
          axisLabel: { color: ink3, fontSize: 11, formatter: (value: number) => formatAxis(value) },
          splitLine: { lineStyle: { color: grid, opacity: 0.6 } },
        },
        series: [
          {
            type: 'scatter',
            symbolSize: 10,
            cursor: onSelect ? 'pointer' : 'default',
            data: points.map((point) => ({
              id: point.id,
              value: [point.x, point.y],
              itemStyle: {
                color: point.id === highlight ? best : accent,
                borderColor: surface,
                borderWidth: 2,
                opacity: 0.9,
              },
              symbolSize: point.id === highlight ? 14 : 10,
            })),
            emphasis: { scale: 1.3, label: { show: false } },
            labelLine: { lineStyle: { color: ink2 } },
          },
        ],
      },
      true,
    )
  }, [points, categories, xLabel, yLabel, logX, logY, highlight, onSelect, theme])

  return <div ref={ref} className="h-[360px] w-full" role="img" aria-label={label} />
}
