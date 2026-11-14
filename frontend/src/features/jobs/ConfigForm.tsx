import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Info, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { api, type ClassSpec, type ParamSpec } from '../../api/client'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import {
  checkParamValue,
  describeRange,
  deleteYamlValue,
  formatInput,
  parseInput,
  setYamlValue,
} from '../../lib/yamlEdit'

type Config = Record<string, unknown>

// 学習率を step ごとに変える前提の Scheduler (scheduler.interval を step にする)
const STEP_SCHEDULERS = new Set(['OneCycleLR', 'CyclicLR'])

/** 入れ子の辞書から点区切りの項目の値を取り出す */
function getIn(config: Config, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (value && typeof value === 'object') return (value as Config)[part]
    return undefined
  }, config)
}

/** config の optimizers に名前付きで書いた Optimizer の名前 (無ければ空) */
function namedOptimizers(config: Config): string[] {
  const named = config.optimizers
  if (!named || typeof named !== 'object' || Array.isArray(named)) return []
  return Object.keys(named)
}

/** 書き換えている途中の文字が落ち着いてから値を使う (読み込みの回数を抑える) */
function useDebounced<T>(value: T, delay: number): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return current
}

/** 1 つの引数の入力欄. 種類に合わせて真偽値か文字の欄を出し, 変えた場合だけ書き込む */
function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec
  value: unknown
  onChange: (value: unknown) => void
}) {
  const id = useId()
  const helpId = useId()
  // 値が無いか null の場合は空にして, 既定値は薄い文字で表示
  const initial = value === null || value === undefined ? '' : formatInput(value)
  const [text, setText] = useState(initial)
  // 入力の誤り (読めない値や範囲の外). 誤りがある間は YAML に書き込まない
  // YAML の欄で直接書いた範囲の外の値も, 作り直した時点で示す
  const [error, setError] = useState<string | null>(() => checkParamValue(spec, value))
  const invalid = error !== null

  const commit = () => {
    if (text === initial) {
      setError(checkParamValue(spec, value))
      return
    }
    const parsed = parseInput(spec.kind, text)
    if (parsed === undefined && text.trim() !== '') {
      setError(`${spec.kind === 'list' ? '[1, 2] のような配列' : '値'}として読めません`)
      return
    }
    const rangeError = checkParamValue(spec, parsed)
    if (rangeError) {
      setError(rangeError)
      return
    }
    setError(null)
    onChange(parsed)
  }

  const range = describeRange(spec)
  // 誤りの間は, 同じ内容になりやすい範囲の説明を省略
  const help = [spec.description, error ? '' : range, error ?? ''].filter(Boolean).join(' · ')

  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-start gap-2">
      <label htmlFor={id} className="pt-1.5 font-mono text-xs break-all text-ink-2">
        {spec.name}
        {spec.required && (
          <span className="text-critical-text" aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      <div className="min-w-0">
        {spec.kind === 'bool' ? (
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            aria-describedby={help ? helpId : undefined}
            className="mt-2 accent-[var(--accent)]"
          />
        ) : (
          <input
            id={id}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === 'Enter' && commit()}
            placeholder={spec.default === null ? '(なし)' : formatInput(spec.default)}
            aria-invalid={invalid}
            aria-required={spec.required}
            aria-describedby={help ? helpId : undefined}
            className="h-8 w-full rounded-md border border-line bg-bg px-2 font-mono text-xs outline-none placeholder:text-ink-3 focus:border-accent aria-[invalid=true]:border-critical"
          />
        )}
        {help && (
          <p
            id={helpId}
            className={
              invalid ? 'mt-0.5 text-[11px] text-critical-text' : 'mt-0.5 text-[11px] text-ink-3'
            }
          >
            {help}
          </p>
        )}
      </div>
    </div>
  )
}

/** Optimizer か Scheduler の名前と引数の欄 */
function ClassSection({
  title,
  section,
  kind,
  specs,
  config,
  allowNone,
  onEdit,
  disabled,
}: {
  title: string
  /** 書き換える config の場所 (optimizer, scheduler, optimizers.<名前> など) */
  section: string
  kind: 'optimizer' | 'scheduler'
  specs: ClassSpec[]
  config: Config
  allowNone: boolean
  disabled: boolean
  onEdit: (change: (text: string) => string) => void
}) {
  const selectId = useId()
  const intervalId = useId()
  const [advanced, setAdvanced] = useState(false)
  // 選び直した名前は, 読み直した config に反映されるまで先に表示
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const resolvedName = getIn(config, `${section}.name`) as string | null | undefined
  const pending = chosen !== undefined && chosen !== resolvedName
  const name = pending ? chosen : resolvedName
  const params = (getIn(config, `${section}.params`) ?? {}) as Config
  const spec = specs.find((item) => item.name === name)
  const shown = spec?.params.filter((param) => advanced || !param.advanced) ?? []
  const hidden = (spec?.params.length ?? 0) - shown.length
  const interval = getIn(config, `${section}.interval`) as string | undefined

  const choose = (value: string | null) => {
    setChosen(value)
    // クラスを変えると引数も変わるので, 新しいクラスにもある引数 (lr など) だけを残す
    const nextSpec = specs.find((item) => item.name === value)
    const kept = Object.fromEntries(
      Object.entries(params).filter(([key, param]) =>
        nextSpec?.params.some((item) => item.name === key && item.default !== param),
      ),
    )
    onEdit((text) => {
      let next = setYamlValue(text, `${section}.name`, value)
      if (value === null) {
        // Scheduler を使わない場合は, 引数と interval を消して名前だけを残す
        next = deleteYamlValue(next, `${section}.params`)
        return deleteYamlValue(next, `${section}.interval`)
      }
      next = setYamlValue(next, `${section}.params`, kept)
      if (kind === 'scheduler' && STEP_SCHEDULERS.has(value)) {
        next = setYamlValue(next, `${section}.interval`, 'step')
      }
      return next
    })
  }

  return (
    <fieldset disabled={disabled} aria-label={title} className="space-y-3 disabled:opacity-60">
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
        <label htmlFor={selectId} className="text-sm font-semibold">
          {title}
        </label>
        <select
          id={selectId}
          value={name ?? ''}
          onChange={(event) => choose(event.target.value || null)}
          className="h-8 rounded-md border border-line bg-bg px-2 font-mono text-xs"
        >
          {allowNone && <option value="">なし</option>}
          {name && !spec && <option value={name}>{name} (自作)</option>}
          {specs.map((item) => (
            <option key={item.name} value={item.name} disabled={!item.supported}>
              {item.name}
              {item.supported ? '' : ' (使えません)'}
            </option>
          ))}
        </select>
      </div>
      {spec?.description && <p className="text-xs text-ink-3">{spec.description}</p>}
      {name && !spec && (
        <p className="text-xs text-ink-3">
          自作のクラスは引数が分からないので, YAML の欄で書いてください.
        </p>
      )}
      {kind === 'scheduler' && name && (
        <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
          <label htmlFor={intervalId} className="font-mono text-xs text-ink-2">
            interval
          </label>
          <select
            id={intervalId}
            value={interval ?? 'epoch'}
            onChange={(event) =>
              onEdit((text) => setYamlValue(text, `${section}.interval`, event.target.value))
            }
            className="h-8 w-44 rounded-md border border-line bg-bg px-2 font-mono text-xs"
          >
            <option value="epoch">epoch (エポックごと)</option>
            <option value="step">step (バッチごと)</option>
          </select>
        </div>
      )}
      {/* 選び直した直後は, 前のクラスの引数を書き換えないように読み直すまで待機 */}
      {pending ? (
        <Spinner label="引数を読み込み中" />
      ) : (
        shown.map((param) => {
          const value = params[param.name] ?? param.default
          return (
            <ParamField
              // 外 (YAML の欄など) で値が変わったら入力欄を作り直して合わせる
              key={`${name}-${param.name}-${formatInput(value)}`}
              spec={param}
              value={value}
              onChange={(next) =>
                onEdit((text) =>
                  next === undefined
                    ? deleteYamlValue(text, `${section}.params.${param.name}`)
                    : setYamlValue(text, `${section}.params.${param.name}`, next),
                )
              }
            />
          )
        })
      )}
      {!pending && (hidden > 0 || advanced) && (
        <button
          type="button"
          onClick={() => setAdvanced((value) => !value)}
          className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
        >
          {advanced ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
          {advanced ? '詳細な引数をたたむ' : `詳細な引数 (${hidden})`}
        </button>
      )}
    </fieldset>
  )
}

/**
 * ML-Found の登録簿をもとに, 学習の回数と Optimizer と Scheduler を選ぶフォーム.
 * 値を変えると experiment の config (YAML の文字) を書き換える
 */
export function ConfigForm({
  projectId,
  script,
  text,
  onChange,
}: {
  projectId: string
  /** 学習のスクリプト (元にする default の config を選ぶのに使う) */
  script: string
  text: string
  onChange: (text: string) => void
}) {
  const epochsId = useId()
  const registry = useQuery({
    queryKey: ['registry'],
    queryFn: api.getRegistry,
    staleTime: Infinity,
  })
  const debounced = useDebounced(text, 400)

  // default と合わせた今の config (フォームの初期値と, 書いていない項目の値)
  const resolved = useQuery({
    queryKey: ['projects', projectId, 'resolve', script, debounced],
    queryFn: () => api.validateConfig(projectId, debounced, script),
    placeholderData: (previous) => previous,
  })

  // 一時的に読めない config になっても, 最後に読めた値でフォームを出し続ける
  // 引数の値の誤り (範囲の外など) は読めた config も返るので, フォームで直せる
  const [lastGood, setLastGood] = useState<Config | null>(null)
  const loaded = resolved.data?.config
  const current =
    resolved.data?.ok || (loaded && Object.keys(loaded).length > 0) ? (loaded as Config) : null
  const valueError = current && resolved.data && !resolved.data.ok ? resolved.data.error : null
  if (current && current !== lastGood) setLastGood(current)
  const config = current ?? lastGood
  // 今の YAML が読めず, 前の値を出している状態 (フォームの値と YAML が合わない)
  const stale = !current && resolved.data !== undefined && !resolved.data.ok
  const [editError, setEditError] = useState<string | null>(null)

  // 続けて書き換える場合 (クラスの名前と引数) も, 直前の書き換えの結果に重ねる
  const latest = useRef(text)
  useEffect(() => {
    latest.current = text
  }, [text])
  const onEdit = (change: (current: string) => string) => {
    try {
      latest.current = change(latest.current)
      onChange(latest.current)
      setEditError(null)
    } catch (error) {
      setEditError(`YAML として読めないので, フォームから書き換えられません: ${String(error)}`)
    }
  }

  const epochs = config ? getIn(config, 'trainer.epochs') : undefined
  const [epochsInvalid, setEpochsInvalid] = useState(false)
  const commitEpochs = (raw: string) => {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) {
      setEpochsInvalid(true)
      return
    }
    setEpochsInvalid(false)
    if (value !== epochs) onEdit((now) => setYamlValue(now, 'trainer.epochs', value))
  }

  return (
    <Card title="フォームで設定">
      {registry.isPending || (!config && resolved.isPending) ? (
        <Spinner />
      ) : registry.error ? (
        <ErrorBox error={registry.error} />
      ) : resolved.error && !config ? (
        <ErrorBox error={resolved.error} />
      ) : !config ? (
        <p className="text-sm text-ink-3">
          config に誤りがあるのでフォームを表示できません. YAML の欄を直すか,
          「確かめる」で理由を見てください.
        </p>
      ) : (
        <div className="space-y-6">
          {valueError && <ErrorBox error={valueError} live={false} />}
          {stale && (
            <>
              <ErrorBox error={resolved.data?.error} live={false} />
              <p className="text-xs text-ink-3">
                最後に読めた config を表示しています. YAML
                の欄を直すまでフォームは書き換えられません.
              </p>
            </>
          )}
          {(resolved.data?.notes ?? []).map((note) => (
            <p key={note} className="flex items-start gap-1.5 text-xs text-ink-3">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {note}
            </p>
          ))}
          {resolved.data?.ok &&
            (resolved.data.warnings ?? []).map((warning) => (
              <p key={warning} className="flex items-start gap-1.5 text-xs text-warning-text">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {warning}
              </p>
            ))}
          <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
            <label htmlFor={epochsId} className="text-sm font-semibold">
              エポック数
            </label>
            <input
              id={epochsId}
              type="number"
              min={1}
              step={1}
              defaultValue={String(epochs ?? '')}
              key={String(epochs)}
              onBlur={(event) => commitEpochs(event.target.value)}
              onKeyDown={(event) =>
                event.key === 'Enter' && commitEpochs(event.currentTarget.value)
              }
              aria-invalid={epochsInvalid}
              disabled={stale}
              className="h-8 w-32 rounded-md border border-line bg-bg px-2 font-mono text-xs aria-[invalid=true]:border-critical"
            />
          </div>
          {/* 名前付きの複数の Optimizer (optimizers) は, 名前ごとに Optimizer と Scheduler */}
          {(namedOptimizers(config).length > 0
            ? namedOptimizers(config).map((name) => ({
                key: name,
                optimizer: `optimizers.${name}`,
                scheduler: `optimizers.${name}.scheduler`,
                suffix: ` (${name})`,
              }))
            : [{ key: '', optimizer: 'optimizer', scheduler: 'scheduler', suffix: '' }]
          ).map((entry) => (
            <div key={entry.key} className="space-y-6">
              <ClassSection
                title={`Optimizer${entry.suffix}`}
                section={entry.optimizer}
                kind="optimizer"
                specs={registry.data?.optimizers ?? []}
                config={config}
                allowNone={false}
                disabled={stale}
                onEdit={onEdit}
              />
              <ClassSection
                title={`Scheduler${entry.suffix}`}
                section={entry.scheduler}
                kind="scheduler"
                specs={registry.data?.schedulers ?? []}
                config={config}
                allowNone
                disabled={stale}
                onEdit={onEdit}
              />
            </div>
          ))}
          {editError && <ErrorBox error={editError} live={false} />}
          <p className="text-[11px] text-ink-3">
            フォームで変えた値は YAML の欄にも書き込まれます. * は必須の引数です.
          </p>
        </div>
      )}
    </Card>
  )
}
