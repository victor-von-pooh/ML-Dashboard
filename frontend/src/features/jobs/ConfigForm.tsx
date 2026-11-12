import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { api, type ClassSpec, type ParamSpec } from '../../api/client'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { deleteYamlValue, formatInput, parseInput, setYamlValue } from '../../lib/yamlEdit'

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
  const [invalid, setInvalid] = useState(false)

  const commit = () => {
    if (text === initial) return
    const parsed = parseInput(spec.kind, text)
    if (parsed === undefined && text.trim() !== '') {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onChange(parsed)
  }

  const range = [
    spec.minimum != null ? `${spec.minimum} 以上` : '',
    spec.maximum != null ? `${spec.maximum} 以下` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const help = [
    spec.description,
    range,
    invalid ? `${spec.kind === 'list' ? '[1, 2] のような配列' : '値'}として読めません` : '',
  ]
    .filter(Boolean)
    .join(' · ')

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
  specs,
  config,
  allowNone,
  onEdit,
}: {
  title: string
  section: 'optimizer' | 'scheduler'
  specs: ClassSpec[]
  config: Config
  allowNone: boolean
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
  const interval = getIn(config, 'scheduler.interval') as string | undefined

  const choose = (value: string | null) => {
    setChosen(value)
    // クラスを変えると引数も変わるので, 引数を空にしてから名前を設定
    onEdit((text) => {
      let next = setYamlValue(text, `${section}.params`, {})
      next = setYamlValue(next, `${section}.name`, value)
      if (section === 'scheduler' && value && STEP_SCHEDULERS.has(value)) {
        next = setYamlValue(next, 'scheduler.interval', 'step')
      }
      return next
    })
  }

  return (
    <section className="space-y-3">
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
      {section === 'scheduler' && name && (
        <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
          <label htmlFor={intervalId} className="font-mono text-xs text-ink-2">
            interval
          </label>
          <select
            id={intervalId}
            value={interval ?? 'epoch'}
            onChange={(event) =>
              onEdit((text) => setYamlValue(text, 'scheduler.interval', event.target.value))
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
    </section>
  )
}

/**
 * ML-Found の登録簿をもとに, 学習の回数と Optimizer と Scheduler を選ぶフォーム.
 * 値を変えると experiment の config (YAML の文字) を書き換える
 */
export function ConfigForm({
  projectId,
  text,
  onChange,
}: {
  projectId: string
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
    queryKey: ['projects', projectId, 'resolve', debounced],
    queryFn: () => api.validateConfig(projectId, debounced),
    placeholderData: (previous) => previous,
  })

  // 一時的に読めない config になっても, 最後に読めた値でフォームを出し続ける
  const [lastGood, setLastGood] = useState<Config | null>(null)
  const current = resolved.data?.ok ? (resolved.data.config as Config) : null
  if (current && current !== lastGood) setLastGood(current)
  const config = current ?? lastGood
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
          {resolved.data && !resolved.data.ok && (
            <ErrorBox error={resolved.data.error} live={false} />
          )}
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
              className="h-8 w-32 rounded-md border border-line bg-bg px-2 font-mono text-xs aria-[invalid=true]:border-critical"
            />
          </div>
          <ClassSection
            title="Optimizer"
            section="optimizer"
            specs={registry.data?.optimizers ?? []}
            config={config}
            allowNone={false}
            onEdit={onEdit}
          />
          <ClassSection
            title="Scheduler"
            section="scheduler"
            specs={registry.data?.schedulers ?? []}
            config={config}
            allowNone
            onEdit={onEdit}
          />
          {editError && <ErrorBox error={editError} live={false} />}
          <p className="text-[11px] text-ink-3">
            フォームで変えた値は YAML の欄にも書き込まれます. * は必須の引数です.
          </p>
        </div>
      )}
    </Card>
  )
}
