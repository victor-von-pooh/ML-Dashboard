import clsx from 'clsx'
import {
  CheckCircle2,
  Info,
  PackageCheck,
  PackageX,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { encodeRunId, isCopyRefused, type RelaunchPlan, type Requirement } from '../../api/client'
import {
  useConfig,
  useCreateJob,
  useProject,
  useRecheckRequirements,
  useRelaunch,
  useRequiresStatus,
  useValidateConfig,
} from '../../api/hooks'
import { Button, Card, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { formatValue } from '../../lib/format'
import { deleteYamlValue, getYamlValue, setYamlValue } from '../../lib/yamlEdit'
import { configForScript } from '../../lib/scripts'
import { RequirementCard } from '../requirements/RequirementCard'
import { ConfigForm } from './ConfigForm'

// 実験の config の中身 (プロジェクトの experiment の config の一覧に無いもの) を
// 選んでいることを表す, config の選択の値
const RUN_CONFIG = 'run:'

/**
 * 学習を起動する画面. URL に ?run=<実験の ID> があれば, その実験の起動のしかた
 * (source.yaml) を入れた状態で開く
 */
export function LaunchPage() {
  const { projectId = '' } = useParams()
  const [params] = useSearchParams()
  const runId = params.get('run') || null
  const plan = useRelaunch(projectId, runId)

  // 実験の詳細で読んだ古い結果で始めないように, 開いてから読み直すまで待つ
  if (runId !== null && !plan.isFetchedAfterMount) return <Spinner />
  // 実験の設定を読めない場合も, 理由を出して空の画面で起動できるようにする
  return (
    <LaunchForm
      // 別の実験から開き直したら, 選んだものと書き換えた中身を作り直す
      key={`${projectId}:${runId ?? ''}`}
      projectId={projectId}
      runId={runId}
      plan={plan.data ?? null}
      planError={plan.error}
    />
  )
}

/** config とスクリプトを選び, 必要なら書き換えて学習を起動するフォーム */
function LaunchForm({
  projectId,
  runId,
  plan: initialPlan,
  planError,
}: {
  projectId: string
  runId: string | null
  plan: RelaunchPlan | null
  planError: Error | null
}) {
  // 開いたときの結果に固定し, 後から読み直した結果で選んだものを変えない
  const [plan] = useState(initialPlan)
  const project = useProject(projectId)
  const navigate = useNavigate()
  const scriptId = useId()
  const configId = useId()
  const editorId = useId()
  const requiresNoticeId = useId()

  // 実験から開いた場合は, その実験のスクリプトと config を最初に選択
  const fromRun = plan !== null && plan.reason == null ? plan : null
  const runText = fromRun?.config_text ?? ''
  const [script, setScript] = useState<string | null>(fromRun?.script ?? null)
  const [chosenPath, setChosenPath] = useState<string | null>(
    fromRun ? (fromRun.config_path ?? RUN_CONFIG) : null,
  )
  // 書き換えた中身は, どの config を書き換えたかと組で保存
  // 実験の上書き (overrides) を重ねた中身は, 選んだ config を書き換えたものとして扱う
  const [draft, setDraft] = useState<{ path: string | null; text: string } | null>(
    fromRun?.config_path ? { path: fromRun.config_path, text: runText } : null,
  )
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
  // 実験の config の中身を選んでいる間は, プロジェクトのファイルを読まない
  const usingRunConfig = fromRun !== null && configPath === RUN_CONFIG
  const filePath = usingRunConfig ? null : configPath
  const config = useConfig(projectId, filePath)
  // 起動の前の確認は, 実験のスクリプトのままなら実験が元にした default で行う
  const defaultConfig =
    fromRun?.default_config && selectedScript === fromRun.script
      ? fromRun.default_config
      : undefined

  // 選んだ config を書き換えていればその中身, いなければ読み込んだ中身
  // 元と同じ中身に戻した場合は書き換えていないものとして扱い
  const original = usingRunConfig ? runText : (config.data?.text ?? '')
  // 読み込みの間は, 元の中身が分からないので書き換えていないものとして扱い
  const edited =
    draft !== null &&
    draft.path === configPath &&
    (usingRunConfig || config.data !== undefined) &&
    draft.text !== original
  const text = draft !== null && draft.path === configPath ? draft.text : original
  const loadingConfig = filePath !== null && config.isPending
  // 実験に写したモデルの定義を使う間 (model.spec が写しを指す間) だけ, そのお知らせと
  // 今の定義に戻すボタンを出す
  const copySpec = fromRun?.model_spec ?? null
  const usingCopy = copySpec !== null && getYamlValue(text, 'model.spec') === copySpec

  // config の requires に書いた機能が足りなければ, 開始のボタンを止めて次の一手を出す
  // (起動の API も同じ決まりで止めるので, 確かめる前に押しても学習は始まらない)
  const requires = useRequiresStatus(
    projectId,
    text,
    selectedScript,
    defaultConfig,
    !loadingConfig && !config.error,
  )
  const recheck = useRecheckRequirements(projectId)
  const missingRequirements = requires.data?.missing ?? []
  const requiresError = requires.data?.error ?? null
  const blockedByRequires = missingRequirements.length > 0 || requiresError !== null
  // 書き換えた中身の requires をまだ確かめていない間も開始しない
  const requiresPending = requires.pending

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

  // フォームに誤りのある欄 (読めない値, 範囲の外) があれば開始しない. その欄の
  // 値は YAML に書き込んでいないので, 開始すると前の値で学習してしまうため
  const formRef = useRef<HTMLDivElement>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const selectConfig = (path: string) => {
    setFormError(null)
    if (edited && !window.confirm('書き換えた内容を捨てて, 別の config に切り替えますか?')) return
    setChosenPath(path)
    setDraft(null)
    validate.reset()
  }

  // スクリプトを替えたら, 対応する experiment の config があれば合わせて選択
  // 書き換えた内容を捨てない場合は, スクリプトも替えずにそのまま
  const selectScript = (next: string) => {
    setFormError(null)
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
    setFormError(null)
    setDraft({ path: configPath, text: value })
    validate.reset()
  }

  const launch = () => {
    // 使えない (YAML が読めずに止めている) 欄は除く
    const invalid = formRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]:not(:disabled)',
    )
    if (invalid) {
      setFormError('フォームに誤りのある欄があります. 直してから開始してください')
      invalid.focus()
      return
    }
    setFormError(null)
    create.mutate(
      edited || !filePath
        ? { script: selectedScript, config_text: text, default_config: defaultConfig }
        : { script: selectedScript, config_path: filePath, default_config: defaultConfig },
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
        actions={
          <Link
            to={`/projects/${projectId}/requirements`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
          >
            <PackageCheck className="size-4" aria-hidden />
            追加の依存
          </Link>
        }
      />

      {runId !== null && (
        <RunSourceNotice
          projectId={projectId}
          runId={runId}
          plan={plan}
          error={planError}
          defaultConfig={defaultConfig}
          copyNote={usingCopy ? (fromRun?.model_spec_note ?? null) : null}
          copyRefused={usingCopy && isCopyRefused(create.error)}
          onRestoreSpec={() => {
            // model.spec だけを今の定義 (戻す値が無ければ default の値) に戻す
            const original = fromRun?.model_spec_original ?? null
            // 写しを使えなかった起動のエラーも消す (今の定義で起動し直すため)
            create.reset()
            editText(
              original === null
                ? deleteYamlValue(text, 'model.spec')
                : setYamlValue(text, 'model.spec', original),
            )
          }}
        />
      )}

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
                  {fromRun && !fromRun.config_path && (
                    <option value={RUN_CONFIG}>実験 {runId} の config</option>
                  )}
                  {/* 一覧を読んだ後に作られた config も選べるように追加 */}
                  {[
                    ...configs,
                    ...(fromRun?.config_path && !configs.includes(fromRun.config_path)
                      ? [fromRun.config_path]
                      : []),
                  ].map((item) => (
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

          <div ref={formRef}>
            <ConfigForm
              // config かスクリプトを選び直したら, フォームの状態 (選び直した名前など) も作り直す
              key={`${selectedScript}:${configPath ?? 'none'}`}
              projectId={projectId}
              script={selectedScript}
              text={text}
              onChange={editText}
            />
          </div>

          <Card title="起動の前の確認">
            <div className="space-y-3 text-sm">
              <Button
                icon={ShieldCheck}
                onClick={() => validate.mutate({ text, script: selectedScript, defaultConfig })}
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
                  {(validate.data.notes ?? []).map((note) => (
                    <p key={note} className="mt-2 flex items-start gap-1.5 text-xs text-ink-3">
                      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {note}
                    </p>
                  ))}
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

          <RequiresNotice
            id={requiresNoticeId}
            projectId={projectId}
            missing={missingRequirements}
            error={requiresError}
            unknown={requires.data?.unknown ?? []}
            checkError={requires.data?.check_error ?? null}
            onRecheck={() => recheck.mutate()}
            rechecking={recheck.isPending || requires.isFetching}
            pending={requiresPending}
            requestError={requires.error ?? recheck.error ?? null}
          />
          {formError && <ErrorBox error={formError} />}
          {create.error && <ErrorBox error={create.error} />}
          <Button
            variant="primary"
            icon={Play}
            className="h-10 w-full"
            disabled={
              !selectedScript ||
              create.isPending ||
              loadingConfig ||
              blockedByRequires ||
              requiresPending
            }
            onClick={launch}
            aria-describedby={blockedByRequires || requiresPending ? requiresNoticeId : undefined}
          >
            学習を開始
          </Button>
        </div>

        <Card
          title={<label htmlFor={editorId}>config の中身</label>}
          actions={
            edited && (usingRunConfig || config.data) ? (
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

/** config の requires に書いた機能のうち, 足りないものと確かめられないもの */
function RequiresNotice({
  id,
  projectId,
  missing,
  error,
  unknown,
  checkError,
  onRecheck,
  rechecking,
  pending,
  requestError,
}: {
  id: string
  projectId: string
  missing: Requirement[]
  error: string | null
  unknown: string[]
  checkError: string | null
  onRecheck: () => void
  rechecking: boolean
  pending: boolean
  requestError: Error | null
}) {
  // 開始のボタンを押せない理由の短い要約 (読み上げと aria-describedby に使う)
  const summary = pending
    ? 'config の requires を確かめています'
    : missing.length > 0
      ? `${missing.map((item) => item.name).join(', ')} が足りないので開始できません`
      : error
        ? 'config の requires に誤りがあるので開始できません'
        : ''
  const link = (
    <Link to={`/projects/${projectId}/requirements`} className="text-accent-text hover:underline">
      追加の依存の一覧
    </Link>
  )
  return (
    <div className="space-y-3">
      <p id={id} role="status" className="sr-only">
        {summary}
      </p>
      {requestError && (
        <p className="flex items-start gap-1.5 text-xs text-warning-text">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          requires を確かめられませんでした: {requestError.message}
        </p>
      )}
      {error && <ErrorBox error={`config の requires の誤り: ${error}`} live={false} />}
      {missing.length > 0 && (
        <Card
          title={
            <span className="flex items-center gap-1.5 text-critical-text">
              <PackageX className="size-4" aria-hidden />
              足りない追加の依存があるので開始できません
            </span>
          }
          actions={
            <Button variant="ghost" icon={RefreshCw} onClick={onRecheck} disabled={rechecking}>
              確かめ直す
            </Button>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-ink-2">
              config の requires に書いた機能が, プロジェクトの Python に入っていません.
              次の一手で入れてから「確かめ直す」を押します ({link}).
            </p>
            {missing.map((requirement) => (
              <RequirementCard key={requirement.name} requirement={requirement} />
            ))}
          </div>
        </Card>
      )}
      {unknown.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-warning-text">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          requires の {unknown.join(', ')} は ML-Found の登録簿に無いので, 確かめていません
        </p>
      )}
      {checkError && (
        <p className="flex items-start gap-1.5 text-xs text-warning-text">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          requires の機能が入っているかを確かめられませんでした (開始は止めません): {checkError}
        </p>
      )}
    </div>
  )
}

/** 実験から開いた場合に, 何を入れたかと, 入れられない理由を出す */
function RunSourceNotice({
  projectId,
  runId,
  plan,
  error,
  defaultConfig,
  copyNote,
  copyRefused,
  onRestoreSpec,
}: {
  projectId: string
  runId: string
  plan: RelaunchPlan | null
  error: Error | null
  defaultConfig: string | undefined
  copyNote: string | null
  copyRefused: boolean
  onRestoreSpec: () => void
}) {
  const runLink = (
    <Link
      to={`/projects/${projectId}/runs/${encodeRunId(runId)}`}
      className="font-mono break-all text-accent-text hover:underline"
    >
      {runId}
    </Link>
  )
  if (error) {
    return (
      <div className="mb-4">
        <ErrorBox error={error}>
          <p className="mt-1">実験 {runId} の設定を読めませんでした.</p>
        </ErrorBox>
      </div>
    )
  }
  if (plan?.reason) {
    return (
      <p className="mb-4 flex items-start gap-1.5 text-sm text-warning-text">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          実験 {runLink} の設定は入れられません: {plan.reason}
        </span>
      </p>
    )
  }
  return (
    <div className="mb-4 space-y-1 text-sm text-ink-2">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          実験 {runLink} のスクリプトと experiment の config を入れました
          {defaultConfig && (
            <>
              . 起動の前の確認は, 実験が元にした default (
              <span className="font-mono">{defaultConfig}</span>) で行います
            </>
          )}
        </span>
      </p>
      {copyNote && (
        <p className="flex flex-wrap items-start gap-1.5 text-xs text-ink-3">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {copyRefused
              ? '写した定義が使えなくなったので起動していません. 「今の定義で起動する」を押すか, 実験の詳細から開き直してください'
              : copyNote}
          </span>
          <Button variant="ghost" icon={RotateCcw} onClick={onRestoreSpec}>
            今の定義で起動する
          </Button>
        </p>
      )}
      {(plan?.notes ?? []).map((note) => (
        <p key={note} className="flex items-start gap-1.5 text-xs text-ink-3">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {note}
        </p>
      ))}
    </div>
  )
}
