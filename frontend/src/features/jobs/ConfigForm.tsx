import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { api, type ClassSpec, type ParamSpec } from '../../api/client'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { deleteYamlValue, formatInput, parseInput, setYamlValue } from '../../lib/yamlEdit'

type Config = Record<string, unknown>

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

/** 1 つの引数の入力欄. 種類に合わせて数値, 真偽値, 文字の欄を出す */
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
  const [text, setText] = useState(formatInput(value))
  const [invalid, setInvalid] = useState(false)

  const commit = () => {
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

  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-start gap-2">
      <label htmlFor={id} className="pt-1.5 font-mono text-xs break-all text-ink-2">
        {spec.name}
        {spec.required && <span className="text-critical-text"> *</span>}
      </label>
      <div className="min-w-0">
        {spec.kind === 'bool' ? (
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-2 accent-[var(--accent)]"
          />
        ) : (
          <input
            id={id}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === 'Enter' && commit()}
            placeholder={spec.default === null ? 'null' : formatInput(spec.default)}
            aria-invalid={invalid}
            className="h-8 w-full rounded-md border border-line bg-bg px-2 font-mono text-xs outline-none focus:border-accent aria-[invalid=true]:border-critical"
          />
        )}
        <p className="mt-0.5 text-[11px] text-ink-3">
          {[spec.description, range, invalid ? `${spec.kind} の値として読めません` : '']
            .filter(Boolean)
            .join(' · ')}
        </p>
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
  onSet,
  onDelete,
}: {
  title: string
  section: 'optimizer' | 'scheduler'
  specs: ClassSpec[]
  config: Config
  allowNone: boolean
  onSet: (key: string, value: unknown) => void
  onDelete: (key: string) => void
}) {
  const selectId = useId()
  const [advanced, setAdvanced] = useState(false)
  const name = getIn(config, `${section}.name`) as string | null | undefined
  const params = (getIn(config, `${section}.params`) ?? {}) as Config
  const spec = specs.find((item) => item.name === name)
  const shown = spec?.params.filter((param) => advanced || !param.advanced) ?? []
  const hidden = (spec?.params.length ?? 0) - shown.length

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
        <label htmlFor={selectId} className="text-sm font-semibold">
          {title}
        </label>
        <select
          id={selectId}
          value={name ?? ''}
          onChange={(event) => {
            // クラスを変えると引数も変わるので, 引数は空にしてから名前を設定
            const value = event.target.value || null
            onSet(`${section}.params`, {})
            onSet(`${section}.name`, value)
          }}
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
          自作のクラスは引数が分からないので, 右の YAML の欄で書いてください.
        </p>
      )}
      {shown.map((param) => (
        <ParamField
          // 外 (YAML の欄など) で値が変わったら入力欄を作り直して合わせる
          key={`${name}-${param.name}-${formatInput(params[param.name] ?? param.default)}`}
          spec={param}
          value={params[param.name] ?? param.default}
          onChange={(value) =>
            value === undefined
              ? onDelete(`${section}.params.${param.name}`)
              : onSet(`${section}.params.${param.name}`, value)
          }
        />
      ))}
      {hidden > 0 || advanced ? (
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
      ) : null}
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
  const config = (resolved.data?.ok ? resolved.data.config : null) as Config | null
  const [editError, setEditError] = useState<string | null>(null)

  // 続けて書き換える場合 (クラスの名前と引数) も, 直前の書き換えの結果に重ねる
  const latest = useRef(text)
  useEffect(() => {
    latest.current = text
  }, [text])
  const edit = (change: (current: string) => string) => {
    try {
      latest.current = change(latest.current)
      onChange(latest.current)
      setEditError(null)
    } catch (error) {
      setEditError(`YAML として読めないので, フォームから書き換えられません: ${String(error)}`)
    }
  }
  const onSet = (key: string, value: unknown) =>
    edit((current) => setYamlValue(current, key, value))
  const onDelete = (key: string) => edit((current) => deleteYamlValue(current, key))

  return (
    <Card title="フォームで設定">
      {registry.isPending || (!config && resolved.isPending) ? (
        <Spinner />
      ) : registry.error ? (
        <ErrorBox error={registry.error} />
      ) : !config ? (
        <p className="text-sm text-ink-3">
          config に誤りがあるのでフォームを表示できません. YAML の欄を直すか,
          「確かめる」で理由を見てください.
        </p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-2">
            <label htmlFor={epochsId} className="text-sm font-semibold">
              エポック数
            </label>
            <input
              id={epochsId}
              type="number"
              min={1}
              defaultValue={String(getIn(config, 'trainer.epochs') ?? '')}
              key={String(getIn(config, 'trainer.epochs'))}
              onBlur={(event) => {
                const value = Number(event.target.value)
                if (Number.isInteger(value) && value > 0) onSet('trainer.epochs', value)
              }}
              className="h-8 w-32 rounded-md border border-line bg-bg px-2 font-mono text-xs"
            />
          </div>
          <ClassSection
            title="Optimizer"
            section="optimizer"
            specs={registry.data?.optimizers ?? []}
            config={config}
            allowNone={false}
            onSet={onSet}
            onDelete={onDelete}
          />
          <ClassSection
            title="Scheduler"
            section="scheduler"
            specs={registry.data?.schedulers ?? []}
            config={config}
            allowNone
            onSet={onSet}
            onDelete={onDelete}
          />
          {editError && <ErrorBox error={editError} live={false} />}
          <p className="text-[11px] text-ink-3">
            フォームで変えた値は右の YAML の欄にも書き込まれます. * は必須の引数です.
          </p>
        </div>
      )}
    </Card>
  )
}
