import clsx from 'clsx'
import { CheckCircle2, Play, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useConfig, useCreateJob, useProject, useValidateConfig } from '../../api/hooks'
import { Button, Card, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { formatValue } from '../../lib/format'
import { configForScript } from '../../lib/scripts'
import { ConfigForm } from './ConfigForm'

/** config とスクリプトを選び, 必要なら書き換えて学習を起動する画面 */
export function LaunchPage() {
  const { projectId = '' } = useParams()
  const project = useProject(projectId)
  const navigate = useNavigate()
  const scriptId = useId()
  const configId = useId()
  const editorId = useId()

  const [script, setScript] = useState<string | null>(null)
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  // 書き換えた中身は, どの config を書き換えたかと組で保存
  const [draft, setDraft] = useState<{ path: string | null; text: string } | null>(null)
  const validate = useValidateConfig(projectId)
  const create = useCreateJob(projectId)

  // 最初はプロジェクトの train.py と既定の experiment の config を選択
  const scripts = project.data?.scripts ?? []
  const configs = project.data?.experiment_configs ?? []
  const selectedScript = script ?? (scripts.includes('train.py') ? 'train.py' : scripts[0]) ?? ''
  // スクリプトに対応する config (train_hf.py なら hf.yaml), 次に train.yaml,
  // どちらも無い場合は examples/ の外の最初の config を選択
  const configPath =
    chosenPath ??
    configForScript(selectedScript, configs) ??
    configs.find((path) => path === 'configs/experiment/train.yaml') ??
    configs.find((path) => !path.includes('/examples/')) ??
    configs[0] ??
    null
  const config = useConfig(projectId, configPath)

  // 選んだ config を書き換えていればその中身, いなければ読み込んだ中身
  // 元と同じ中身に戻した場合は書き換えていないものとして扱い
  const original = config.data?.text ?? ''
  const edited = draft !== null && draft.path === configPath && draft.text !== original
  const text = draft !== null && draft.path === configPath ? draft.text : original
  const loadingConfig = configPath !== null && config.isPending

  // 書き換えたまま再読み込みやタブを閉じる場合はブラウザで確認
  useEffect(() => {
    if (!edited) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // 古いブラウザでは returnValue の設定も必要
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [edited])

  const selectConfig = (path: string) => {
    if (edited && !window.confirm('書き換えた内容を捨てて, 別の config に切り替えますか?')) return
    setChosenPath(path)
    setDraft(null)
    validate.reset()
  }

  // スクリプトを替えたら, 対応する experiment の config があれば合わせて選択
  // 書き換えた内容を捨てない場合は, スクリプトも替えずにそのまま
  const selectScript = (next: string) => {
    const matched = configForScript(next, configs)
    const switching = matched !== undefined && matched !== configPath
    if (
      switching &&
      edited &&
      !window.confirm(
        `書き換えた内容を捨てて, ${next} と ${matched.replace('configs/experiment/', '')} に切り替えますか?`,
      )
    )
      return
    setScript(next)
    validate.reset()
    if (switching) {
      setChosenPath(matched)
      setDraft(null)
    }
  }

  const editText = (value: string) => {
    setDraft({ path: configPath, text: value })
    validate.reset()
  }

  const launch = () => {
    create.mutate(
      edited || !configPath
        ? { script: selectedScript, config_text: text }
        : { script: selectedScript, config_path: configPath },
      { onSuccess: (job) => navigate(`/jobs/${job.id}`) },
    )
  }

  if (project.isPending) return <Spinner />
  if (project.error) return <ErrorBox error={project.error} />

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link to="/" className="hover:text-ink">
              プロジェクト
            </Link>
            {' / '}
            <Link to={`/projects/${projectId}`} className="hover:text-ink">
              {project.data.name}
            </Link>
          </>
        }
        title="学習を起動"
        subtitle="プロジェクトの Python で学習のスクリプトを別のプロセスとして動かします"
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="設定">
            <div className="space-y-4 text-sm">
              <div>
                <label htmlFor={scriptId} className="mb-1 block text-xs font-medium text-ink-2">
                  学習のスクリプト
                </label>
                {scripts.length === 0 && (
                  <p className="mb-1 text-xs text-critical-text">
                    train で始まる Python のファイル (train.py など) が見つかりません.
                  </p>
                )}
                <select
                  id={scriptId}
                  value={selectedScript}
                  onChange={(event) => selectScript(event.target.value)}
                  className="h-9 w-full rounded-lg border border-line bg-bg px-2 font-mono text-sm"
                >
                  {scripts.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={configId} className="mb-1 block text-xs font-medium text-ink-2">
                  experiment の config
                </label>
                {configs.length === 0 && (
                  <p className="mb-1 text-xs text-ink-3">
                    configs/experiment に yaml がありません. 右の欄に書くか, 空のまま default
                    で起動します.
                  </p>
                )}
                <select
                  id={configId}
                  value={configPath ?? ''}
                  onChange={(event) => selectConfig(event.target.value)}
                  className="h-9 w-full rounded-lg border border-line bg-bg px-2 font-mono text-xs"
                >
                  {configs.map((item) => (
                    <option key={item} value={item}>
                      {item.replace('configs/experiment/', '')}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-ink-3">
                Python: <span className="font-mono break-all">{project.data.python}</span>
              </p>
              {edited && (
                <p className="text-xs text-ink-3">
                  書き換えた config はダッシュボードのデータの置き場に保存して渡します.
                  プロジェクトのファイルは変えません.
                </p>
              )}
            </div>
          </Card>

          <ConfigForm
            // config かスクリプトを選び直したら, フォームの状態 (選び直した名前など) も作り直す
            key={`${selectedScript}:${configPath ?? 'none'}`}
            projectId={projectId}
            script={selectedScript}
            text={text}
            onChange={editText}
          />

          <Card title="起動の前の確認">
            <div className="space-y-3 text-sm">
              <Button
                icon={ShieldCheck}
                onClick={() => validate.mutate({ text, script: selectedScript })}
                disabled={validate.isPending || loadingConfig}
              >
                ML-Found で config を確かめる
              </Button>
              {validate.data?.ok === false && (
                <div className="space-y-1">
                  <ErrorBox error={validate.data.error} />
                  {validate.data.default_config && (
                    <p className="text-xs text-ink-3">
                      default: <span className="font-mono">{validate.data.default_config}</span>
                    </p>
                  )}
                </div>
              )}
              {validate.data?.ok && (
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-good-text">
                    <CheckCircle2 className="size-4" aria-hidden />
                    読み込めました. default との差分 {Object.keys(validate.data.diff).length} 項目
                  </p>
                  {validate.data.default_config && (
                    <p className="mb-2 text-xs text-ink-3">
                      default: <span className="font-mono">{validate.data.default_config}</span>
                    </p>
                  )}
                  <ul className="space-y-0.5 font-mono text-xs text-ink-2">
                    {Object.entries(validate.data.diff).map(([key, value]) => (
                      <li key={key} className="break-all">
                        {key}: {formatValue(value.default)} → {formatValue(value.experiment)}
                      </li>
                    ))}
                  </ul>
                  {(validate.data.warnings ?? []).map((warning) => (
                    <p
                      key={warning}
                      className="mt-2 flex items-start gap-1.5 text-xs text-warning-text"
                    >
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {warning}
                    </p>
                  ))}
                </div>
              )}
              {validate.error && <ErrorBox error={validate.error} />}
            </div>
          </Card>

          {create.error && <ErrorBox error={create.error} />}
          <Button
            variant="primary"
            icon={Play}
            className="h-10 w-full"
            disabled={!selectedScript || create.isPending || loadingConfig}
            onClick={launch}
          >
            学習を開始
          </Button>
        </div>

        <Card
          title={<label htmlFor={editorId}>config の中身</label>}
          actions={
            edited && config.data ? (
              <Button
                variant="ghost"
                icon={RotateCcw}
                onClick={() => {
                  setDraft(null)
                  validate.reset()
                }}
              >
                元に戻す
              </Button>
            ) : undefined
          }
          padded={false}
        >
          {config.error && <ErrorBox error={config.error} />}
          <textarea
            id={editorId}
            value={text}
            spellCheck={false}
            onChange={(event) => editText(event.target.value)}
            className={clsx(
              'block min-h-[520px] w-full resize-y rounded-b-xl bg-bg p-4 font-mono text-xs leading-relaxed outline-none',
              'focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
        </Card>
      </div>
    </>
  )
}
