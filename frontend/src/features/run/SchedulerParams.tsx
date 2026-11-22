import { formatParam, isInline, isInnerScheduler, isRecord } from '../../lib/schedulerParams'

/** 並びの要素の見出し (groups はパラメータグループ, 他は番号) */
function itemLabel(name: string, index: number): string {
  return name === 'groups' ? `パラメータグループ ${index}` : `${name}[${index}]`
}

/** 1 つの引数の値. 1 行で出せないもの (中の Scheduler, 辞書の並び, 辞書) は入れ子にする */
function ParamValue({ name, value }: { name: string; value: unknown }) {
  // 中に Scheduler を持つもの (SequentialLR, ChainedScheduler) は, 中の Scheduler ごとに
  if (name === 'schedulers' && Array.isArray(value) && value.every(isInnerScheduler)) {
    return (
      <ol className="space-y-2">
        {value.map((inner, index) => (
          <li key={index}>
            <div className="font-mono text-xs text-ink">
              {index + 1}. {inner.scheduler}
            </div>
            <div className="mt-1 border-l border-line pl-3">
              <SchedulerParams scheduler={inner.scheduler} params={inner.params} />
            </div>
          </li>
        ))}
      </ol>
    )
  }
  if (isInline(value)) {
    return (
      <span className="font-mono text-xs [overflow-wrap:anywhere] text-ink">
        {formatParam(value)}
      </span>
    )
  }
  // 辞書の並び (OneCycleLR の groups など) は要素ごとの表
  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index}>
            <div className="text-xs text-ink-3">{itemLabel(name, index)}</div>
            <div className="mt-0.5 border-l border-line pl-3">
              {isRecord(item) ? (
                <ParamRows label={`${name} ${index}`} params={item} />
              ) : (
                <span className="font-mono text-xs">{formatParam(item)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="border-l border-line pl-3">
      <ParamRows label={name} params={value as Record<string, unknown>} />
    </div>
  )
}

/** 引数の名前と値の表 */
function ParamRows({ label, params }: { label: string; params: Record<string, unknown> }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{`${label} の引数`}</caption>
      <tbody>
        {Object.entries(params).map(([key, value]) => (
          <tr key={key} className="border-b border-line last:border-b-0">
            <th
              scope="row"
              className="w-px py-1 pr-4 text-left align-top font-mono text-xs font-normal whitespace-nowrap text-ink-2"
            >
              {key}
            </th>
            <td className="py-1 align-top">
              <ParamValue name={key} value={value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Scheduler の主な引数 (ML-Found の run.json の scheduler_params) の表.
 * 記録の無い実験 (書かない版の ML-Found) は何も出さない
 */
export function SchedulerParams({
  scheduler,
  params,
}: {
  scheduler: string
  params: Record<string, unknown> | null | undefined
}) {
  if (!params) return null
  if (Object.keys(params).length === 0) {
    return <p className="text-xs text-ink-3">主な引数はありません.</p>
  }
  return <ParamRows label={scheduler} params={params} />
}
