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
  const highlightRef = useRef(highlight)
  const { theme } = useTheme()

  // 最新の選択の処理を保持 (グラフを作り直さずに差し替え)
  useEffect(() => {
    selectRef.current = onSelect
    highlightRef.current = highlight
  }, [onSelect, highlight])

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chart.on('click', (event) => {
      // まとめた点は, 最良の実験が含まれていればそれを開く
      const data = event.data as { id?: string; ids?: string[] } | undefined
      const target = data?.ids?.includes(highlightRef.current ?? '')
        ? highlightRef.current
        : data?.id
      if (target) selectRef.current?.(target)
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

    // 同じ位置の点は 1 つにまとめて大きくし, 最良の点は最後 (一番上) に描画
    const merged = new Map<string, { x: number | string; y: number; ids: string[] }>()
    for (const point of points) {
      const key = `${point.x}|${point.y}`
      const item = merged.get(key) ?? { x: point.x, y: point.y, ids: [] }
      item.ids.push(point.id)
      merged.set(key, item)
    }
    const items = [...merged.values()].sort(
      (a, b) => Number(a.ids.includes(highlight ?? '')) - Number(b.ids.includes(highlight ?? '')),
    )

    // 数値の軸は両端の点が軸に重ならないように余白を確保
    const pad = (value: { min: number; max: number }, log: boolean, side: -1 | 1) => {
      if (log) return side < 0 ? value.min / 1.5 : value.max * 1.5
      const span = value.max - value.min || Math.abs(value.max) || 1
      return (side < 0 ? value.min : value.max) + side * span * 0.06
    }
    const useLogX = !categories && logX && positiveX
    const useLogY = logY && points.every((point) => point.y > 0)

    chart.setOption(
      {
        animation: false,
        grid: { left: 12, right: 24, top: 24, bottom: 40, containLabel: true },
        tooltip: {
          trigger: 'item',
          backgroundColor: surface,
          borderColor: grid,
          textStyle: { color: cssVar('--text'), fontSize: 12 },
          // 実験の ID と config の値は利用者の書いた文字列なので, HTML として扱わないように変換
          formatter: (params: { data: { ids: string[]; value: [number | string, number] } }) => {
            const [x, y] = params.data.value
            const escape = echarts.format.encodeHTML
            const shownX = typeof x === 'number' ? formatAxis(x) : x
            const ids = params.data.ids
            return [
              ...ids.slice(0, 5).map(escape),
              ...(ids.length > 5 ? [`他 ${ids.length - 5} 件`] : []),
              `${escape(xLabel)}: ${escape(String(shownX))}`,
              `${escape(yLabel)}: ${escape(formatMetric(y))}`,
            ].join('<br/>')
          },
        },
        xAxis: {
          type: categories ? 'category' : useLogX ? 'log' : 'value',
          min: categories
            ? undefined
            : (value: { min: number; max: number }) => pad(value, useLogX, -1),
          max: categories
            ? undefined
            : (value: { min: number; max: number }) => pad(value, useLogX, 1),
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
            showMinLabel: Boolean(categories),
            showMaxLabel: Boolean(categories),
          },
          splitLine: { show: !categories, lineStyle: { color: grid, opacity: 0.6 } },
        },
        yAxis: {
          type: useLogY ? 'log' : 'value',
          min: (value: { min: number; max: number }) => pad(value, useLogY, -1),
          max: (value: { min: number; max: number }) => pad(value, useLogY, 1),
          scale: true,
          axisLabel: {
            color: ink3,
            fontSize: 11,
            formatter: (value: number) => formatAxis(value),
            showMinLabel: false,
            showMaxLabel: false,
          },
          splitLine: { lineStyle: { color: grid, opacity: 0.6 } },
        },
        series: [
          {
            type: 'scatter',
            symbolSize: 10,
            cursor: onSelect ? 'pointer' : 'default',
            data: items.map((item) => {
              const top = item.ids.includes(highlight ?? '')
              return {
                ids: item.ids,
                id: item.ids[0],
                value: [item.x, item.y],
                itemStyle: {
                  color: top ? best : accent,
                  borderColor: surface,
                  borderWidth: 2,
                  opacity: 0.9,
                },
                symbolSize: (top ? 14 : 10) + Math.log2(item.ids.length) * 4,
              }
            }),
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
