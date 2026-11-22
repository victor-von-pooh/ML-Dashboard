import { Info } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { ProblemTraining } from '../../api/client'
import { useProblemTrainings } from '../../api/hooks'
import { deleteYamlValue, setYamlValue } from '../../lib/yamlEdit'

type Config = Record<string, unknown>
type Mode = 'min' | 'max'

// 向きの選択肢 (ML-Found の trainer.mode)
const MODES: { value: Mode; label: string }[] = [
  { value: 'min', label: 'min (小さいほど良い)' },
  { value: 'max', label: 'max (大きいほど良い)' },
]

/** 末尾の区切りを除いた場所 (問題の設定の記録とプロジェクトの場所を比べるため) */
function samePath(left: string | null | undefined, right: string): boolean {
  if (!left) return false
  const trim = (path: string) => path.replace(/\/+$/, '')
  return trim(left) === trim(right)
}

/** 問題の設定 1 件の値を, 選択肢の文にする */
function optionLabel(item: ProblemTraining): string {
  if (item.monitor && item.mode) return `${item.problem} (${item.monitor}, ${item.mode})`
  return `${item.problem} (渡せません)`
}

/** 監視する指標と向きを config に書く (空の指標は消して ML-Found の既定に戻す) */
function writeMonitor(text: string, monitor: string | null, mode: Mode | null): string {
  let next = monitor
    ? setYamlValue(text, 'trainer.monitor', monitor)
    : deleteYamlValue(text, 'trainer.monitor')
  if (mode) next = setYamlValue(next, 'trainer.mode', mode)
  return next
}

/**
 * 学習で監視する指標 (trainer.monitor) と向き (trainer.mode) の欄. default の config
 * が監視する指標を書いていない (骨組みの外の) プロジェクトでは, ML-Pathfinder の問題の
 * 設定の値 (ML-Quest の受け渡しの training) を選んで入れられる. このプロジェクトを記録した
 * 問題の設定があり, まだ指標を書いていなければ, その値を初めに入れる
 */
export function MonitorSection({
  config,
  monitorInDefault,
  projectPath,
  autoFill,
  disabled,
  onEdit,
}: {
  config: Config
  /** default の config が trainer.monitor を書いているか (確かめの前は undefined) */
  monitorInDefault: boolean | undefined
  /** プロジェクトのディレクトリ (問題の設定の記録と比べる) */
  projectPath: string
  /** 問題の設定の値を初めに入れるか (実験の設定でもう一度起動する場合は入れない) */
  autoFill: boolean
  disabled: boolean
  onEdit: (change: (current: string) => string) => void
}) {
  const monitorId = useId()
  const modeId = useId()
  const problemId = useId()
  const sourceId = useId()
  const trainer = (config.trainer ?? {}) as Config
  const monitor = typeof trainer.monitor === 'string' ? trainer.monitor : null
  const mode = trainer.mode === 'max' ? 'max' : 'min'
  // 問題の設定から選べるのは, default の config が指標を書いていない場合だけ
  const offer = monitorInDefault === false
  const trainings = useProblemTrainings(offer)
  const problems = trainings.data?.problems ?? []
  // 値を入れた問題の設定 (problem.yaml の場所)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const source = problems.find((item) => item.problem_path === sourcePath) ?? null

  const fill = (item: ProblemTraining) => {
    if (!item.monitor || !item.mode) return
    setSourcePath(item.problem_path)
    onEdit((text) => writeMonitor(text, item.monitor ?? null, item.mode ?? null))
  }

  // このプロジェクトを記録した問題の設定の値を, 開いたときに 1 回だけ入れる
  // (利用者が元に戻した後や書き換えた後には入れ直さない)
  const filled = useRef(false)
  const recorded = problems.find(
    (item) => item.monitor && item.mode && samePath(item.project_path, projectPath),
  )
  useEffect(() => {
    if (filled.current || !autoFill || !offer || !recorded || monitor !== null) return
    filled.current = true
    setSourcePath(recorded.problem_path)
    onEdit((text) => writeMonitor(text, recorded.monitor ?? null, recorded.mode ?? null))
  }, [autoFill, offer, recorded, monitor, onEdit])

  // 欄の文字 (確定したときに書き込む)
  const [draft, setDraft] = useState(monitor ?? '')
  const [seen, setSeen] = useState(monitor)
  if (seen !== monitor) {
    setSeen(monitor)
    setDraft(monitor ?? '')
  }
  const commit = () => {
    const value = draft.trim()
    if (value === (monitor ?? '')) return
    onEdit((text) => writeMonitor(text, value || null, null))
  }

  // 値の出どころ: 入れた値のままか, 利用者が変えたか
  const matches = source !== null && source.monitor === monitor && source.mode === mode
  const note =
    source === null || monitor === null
      ? null
      : matches
        ? `問題の設定「${source.problem}」の学習で監視する指標と向きです (ML-Quest の受け渡し).`
        : `問題の設定「${source.problem}」の値 (${source.monitor}, ${source.mode}) から変えています.`

  return (
    <fieldset
      disabled={disabled}
      aria-label="学習で監視する指標と向き"
      className="space-y-3 disabled:opacity-60"
    >
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
        <label htmlFor={monitorId} className="text-sm font-semibold">
          監視する指標
        </label>
        <input
          id={monitorId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
          placeholder="(なし: valid/loss か train/loss)"
          aria-describedby={note ? sourceId : undefined}
          className="h-8 w-full rounded-md border border-line bg-bg px-2 font-mono text-xs outline-none placeholder:text-ink-3 focus:border-accent"
        />
        <label htmlFor={modeId} className="text-sm font-semibold">
          向き
        </label>
        <select
          id={modeId}
          value={mode}
          onChange={(event) =>
            onEdit((text) => setYamlValue(text, 'trainer.mode', event.target.value))
          }
          aria-describedby={note ? sourceId : undefined}
          className="h-8 w-44 rounded-md border border-line bg-bg px-2 font-mono text-xs"
        >
          {MODES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      {note && (
        <p id={sourceId} className="flex items-start gap-1.5 text-xs text-ink-3">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-all">
            {note} <span className="font-mono">{source?.problem_path}</span>
          </span>
        </p>
      )}
      {offer && (
        <div className="space-y-1">
          {trainings.error ? (
            <p className="flex items-start gap-1.5 text-xs text-ink-3">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              問題の設定の値は使えません: {trainings.error.message}
            </p>
          ) : (
            trainings.data && (
              <ProblemPicker
                id={problemId}
                problems={problems}
                chosen={sourcePath}
                onChoose={(path) => {
                  const item = problems.find((entry) => entry.problem_path === path)
                  if (item) fill(item)
                }}
              />
            )
          )}
        </div>
      )}
    </fieldset>
  )
}

/** ML-Pathfinder の問題の設定を選び, その監視する指標と向きを入れる欄 */
function ProblemPicker({
  id,
  problems,
  chosen,
  onChoose,
}: {
  id: string
  problems: ProblemTraining[]
  chosen: string | null
  onChoose: (path: string) => void
}) {
  const hintId = useId()
  const unusable = problems.filter((item) => !item.monitor || !item.mode)
  if (problems.length === 0) {
    return (
      <p className="text-xs text-ink-3">
        default の config は監視する指標を書いていません. ML-Pathfinder の問題の設定があれば,
        その値を選んで入れられます.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-start gap-2">
      <label htmlFor={id} className="pt-1.5 text-sm font-semibold">
        問題の設定から
      </label>
      <div className="min-w-0 space-y-1">
        <select
          id={id}
          value={chosen ?? ''}
          onChange={(event) => event.target.value && onChoose(event.target.value)}
          aria-describedby={hintId}
          className="h-8 w-full rounded-md border border-line bg-bg px-2 text-xs"
        >
          <option value="">選ぶ</option>
          {problems.map((item) => (
            <option
              key={item.problem_path}
              value={item.problem_path}
              disabled={!item.monitor || !item.mode}
            >
              {optionLabel(item)}
            </option>
          ))}
        </select>
        <p id={hintId} className="text-[11px] text-ink-3">
          default の config は監視する指標を書いていないので, 問題の設定 (ML-Pathfinder)
          の学習で監視する指標と向きを選んで入れられます. 入れた後も上の欄で変えられます.
        </p>
        {unusable.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-ink-3">
            {unusable.map((item) => (
              <li key={item.problem_path} className="break-all">
                {item.problem}: {item.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
