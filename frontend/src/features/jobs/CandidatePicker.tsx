import clsx from 'clsx'
import { Info, Layers } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'

import type { BatchInfo } from '../../api/client'
import { useModelSpecs } from '../../api/hooks'
import { Card, ErrorBox } from '../../components/ui'
import { formatBytes } from '../../lib/format'

// まとめて学習する候補の数 (1 つだけなら普通の起動)
export const MIN_CANDIDATES = 2
export const MAX_CANDIDATES = 20

/**
 * モデルの定義の候補の欄. プロジェクトの models/ の定義から 2 つ以上選ぶと, 同じスクリプトと
 * config で定義ごとに順に学習する. default の config に model.spec が無いプロジェクトでは出さない
 */
export function CandidatePicker({
  projectId,
  script,
  defaultConfig,
  currentSpec,
  chosen,
  onChange,
  activeBatch,
}: {
  projectId: string
  script: string
  defaultConfig: string | undefined
  /** 今の experiment の config の model.spec (書いていなければ undefined) */
  currentSpec: unknown
  chosen: string[]
  onChange: (paths: string[]) => void
  /** このプロジェクトで進めている途中のまとまり */
  activeBatch: BatchInfo | undefined
}) {
  const specs = useModelSpecs(projectId, script, defaultConfig)
  const hintId = useId()
  if (specs.error) return <ErrorBox error={specs.error} />
  const data = specs.data
  if (!data?.default_spec) return null
  const shown = typeof currentSpec === 'string' && currentSpec ? currentSpec : data.default_spec
  const full = chosen.length >= MAX_CANDIDATES
  // 選んだ順に学習するので, 押した順を保つ
  const toggle = (path: string) =>
    onChange(
      chosen.includes(path)
        ? chosen.filter((item) => item !== path)
        : full
          ? chosen
          : [...chosen, path],
    )
  return (
    <Card title="モデルの定義の候補">
      <div className="space-y-2 text-sm">
        <p id={hintId} className="text-xs text-ink-3">
          今の config の model.spec: <span className="font-mono break-all">{shown}</span>.{' '}
          {MIN_CANDIDATES} つ以上選ぶと, 同じスクリプトと config で定義ごとに 1 つずつ,
          選んだ順に学習します ({MAX_CANDIDATES} 個まで).
        </p>
        {activeBatch && (
          <p className="flex items-start gap-1.5 text-xs text-warning-text">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              このプロジェクトには進めている途中の候補のまとまりがあります (
              <Link to="/jobs" className="underline">
                ジョブ
              </Link>
              ). 終わるまで新しいまとまりは作れません. 普通の起動はできますが,
              まとまりの次の候補は学習中のジョブを待ちます
            </span>
          </p>
        )}
        {data.notice && <p className="text-xs text-ink-3">{data.notice}</p>}
        {data.specs.length > 0 && (
          <ul
            className="max-h-64 overflow-auto"
            aria-label="モデルの定義の候補"
            aria-describedby={hintId}
          >
            {data.specs.map((spec) => {
              const checked = chosen.includes(spec.path)
              const order = chosen.indexOf(spec.path)
              const disabled = spec.reason != null || (!checked && full)
              return (
                <li key={spec.path}>
                  <label
                    className={clsx(
                      'flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-2',
                      disabled && 'text-ink-3',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(spec.path)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="font-mono break-all">{spec.name}</span>
                    <span className="text-ink-3">{spec.path}</span>
                    {spec.size != null && (
                      <span className="text-ink-3">{formatBytes(spec.size)}</span>
                    )}
                    {checked && (
                      <span className="ml-auto shrink-0 text-[11px] text-accent-text">
                        {order + 1} 番目
                      </span>
                    )}
                    {spec.reason && (
                      <span className="ml-auto shrink-0 text-[11px]">
                        選べません: {spec.reason}
                      </span>
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <Layers className="size-3.5" aria-hidden />
          選んだ候補: {chosen.length} 個
        </p>
      </div>
    </Card>
  )
}
