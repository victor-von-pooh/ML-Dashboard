import { Play, TriangleAlert } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import { useHistory, useLog, useProject, useRelaunch, useResults, useRun } from '../../api/hooks'
import { CopyButton } from '../requirements/RequirementCard'
import {
  Button,
  ErrorBox,
  PageHeader,
  Spinner,
  StatTile,
  StatusBadge,
  Tabs,
} from '../../components/ui'
import { tabPanelProps, useStableId } from '../../lib/a11y'
import { formatDateTime, formatDuration, formatMetric } from '../../lib/format'
import { groupImageSeries } from '../../lib/images'
import { validInterval } from '../../lib/metrics'
import type { RunFile } from '../../api/client'
import { EvaluationsTab } from './EvaluationsTab'
import { PolicyTab } from './PolicyTab'
import { ImageTimeline } from './ImageTimeline'
import { MetricCharts } from './MetricCharts'
import { NotePanel } from './NotePanel'
import { ConfigTab, EnvTab, FilesTab, LogTab, ModelTab } from './RunTabs'
import { SamplesTab } from './SamplesTab'
import { TaskPanel } from './TaskPanel'

// 同じファイルの一覧からは同じ並びを返し, 描画のたびに作り直さないようにする
const seriesCache = new WeakMap<RunFile[], ReturnType<typeof groupImageSeries>>()
function seriesOf(files: RunFile[]) {
  const cached = seriesCache.get(files)
  if (cached) return cached
  const series = groupImageSeries(files)
  seriesCache.set(files, series)
  return series
}

const TAB_IDS = [
  'charts',
  'evaluations',
  'samples',
  'policy',
  'images',
  'config',
  'model',
  'env',
  'log',
  'files',
] as const
type TabId = (typeof TAB_IDS)[number]

/** URL の値を画面のタブに直す */
function toTab(value: string | null): TabId {
  return TAB_IDS.find((id) => id === value) ?? 'charts'
}

/** final_model.pt の重みの説明 (ML-Found の run.json の final_weights) */
const FINAL_WEIGHTS: Record<string, string> = {
  best: 'final_model.pt はベストモデル',
  last: 'final_model.pt は最後のエポック',
  partial: 'final_model.pt は途中までの重み',
}

export function RunDetailPage() {
  const { projectId = '', '*': runId = '' } = useParams()
  const project = useProject(projectId)
  const run = useRun(projectId, runId)
  const running = run.data?.status === 'running'
  const history = useHistory(projectId, runId, running)
  // task.yaml, evaluations/, samples/, policy/ (無い実験は空で, 何の実験かの欄と評価, 見本, 方策のタブを出さない)
  const results = useResults(projectId, runId, running)

  // 学習が終わったら, 最後のエポックの記録と学習の後の評価と見本を読み直す
  const wasRunning = useRef(false)
  const refetchHistory = history.refetch
  const refetchResults = results.refetch
  useEffect(() => {
    if (wasRunning.current && !running) {
      void refetchHistory()
      void refetchResults()
    }
    wasRunning.current = running
  }, [running, refetchHistory, refetchResults])
  const [params, setParams] = useSearchParams()
  const requestedTab = toTab(params.get('tab'))
  const log = useLog(projectId, runId, requestedTab === 'log')
  const idBase = useStableId('run')
  const relaunch = useRelaunch(projectId, runId)
  const relaunchHintId = useStableId('relaunch')

  // 再読み込みやリンクで同じタブを開けるように, タブは URL に保存
  const setTab = (id: TabId) => setParams(id === 'charts' ? {} : { tab: id }, { replace: true })

  const breadcrumb = (
    <>
      <Link to="/" className="hover:text-ink">
        プロジェクト
      </Link>
      {' / '}
      <Link to={`/projects/${projectId}`} className="hover:text-ink">
        {project.data?.name ?? projectId}
      </Link>
    </>
  )

  if (run.isPending) return <Spinner />
  if (run.error) {
    return (
      <>
        <PageHeader breadcrumb={breadcrumb} title={runId} />
        <ErrorBox error={run.error}>
          <Link
            to={`/projects/${projectId}`}
            className="mt-1 inline-block text-accent-text hover:underline"
          >
            実験の一覧に戻る
          </Link>
        </ErrorBox>
      </>
    )
  }
  const data = run.data

  // 番号の付いた画像 (エポックごとの生成画像など) の並び. 無い実験で画像のタブを
  // 開いた場合 (共有したリンクなど) は学習曲線を表示
  const series = seriesOf(data.files)
  const evaluations = results.data?.evaluations ?? []
  const samples = results.data?.samples ?? []
  // 評価と見本は, 読み終えて無いと分かった場合だけ学習曲線に戻す (読む間は待つ)
  const missing =
    (requestedTab === 'images' && series.length === 0) ||
    (requestedTab === 'evaluations' && !results.isPending && evaluations.length === 0) ||
    (requestedTab === 'samples' && !results.isPending && samples.length === 0) ||
    (requestedTab === 'policy' && !results.isPending && !results.data?.policy)
  const tab: TabId = missing ? 'charts' : requestedTab
  const sampleNames = new Set(samples.map((sample) => sample.name)).size

  // 学習中 (running) は「経過」と「最新」(終わってからの学習時間と最終の値の
  // 代わり)
  // ベストモデルを選ばない実験 (best が無い) も, 監視する指標の最後の値を出す
  const monitor = data.best?.monitor ?? data.monitor ?? undefined
  const others = Object.entries(data.final_metrics).filter(
    ([key]) => (key.startsWith('valid/') || key.startsWith('train_eval/')) && key !== monitor,
  )

  return (
    <>
      <PageHeader
        breadcrumb={breadcrumb}
        title={
          <span className="flex items-center gap-3">
            {data.name}
            <StatusBadge status={data.status} />
          </span>
        }
        subtitle={
          <span className="tabular">
            {formatDateTime(data.started_at)} · {data.id}
            {data.model && (
              <>
                {' · '}モデルの定義:{' '}
                <span className="font-mono" title={data.model.path}>
                  {data.model.name}
                </span>
              </>
            )}
          </span>
        }
        actions={
          // 起動できない実験 (source.yaml が無い実験など) は押せなくし, 理由を出す
          // 読めなかった場合は, 起動の画面でエラーを出すのでそのまま開ける
          !relaunch.data?.reason ? (
            <Link
              to={`/projects/${projectId}/launch?${new URLSearchParams({ run: data.id }).toString()}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Play className="size-4" aria-hidden />
              この設定でもう一度起動
            </Link>
          ) : (
            <Button icon={Play} disabled aria-describedby={relaunchHintId}>
              この設定でもう一度起動
            </Button>
          )
        }
      />
      {relaunch.data?.reason && (
        <p id={relaunchHintId} className="-mt-4 mb-4 text-right text-xs text-ink-3">
          もう一度起動できません: {relaunch.data.reason}
        </p>
      )}
      {data.model && data.status === 'completed' && (
        <NextStageNote
          hasBundle={data.files.some((file) => file.path.startsWith('inference/'))}
          path={data.path ?? null}
        />
      )}
      {data.error && <ErrorBox error={data.error} live={false} />}
      {data.notices.map((notice) => (
        <p key={notice} className="mb-4 flex items-start gap-1.5 text-sm text-warning-text">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {notice}
        </p>
      ))}
      {data.final_weights === 'partial' && (
        <p className="mb-4 flex items-start gap-1.5 text-sm text-warning-text">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          エポックの途中で止め, 前のエポックの重みに戻せなかったので, final_model.pt
          は途中までの重みです
        </p>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label={data.best ? `ベスト ${data.best.monitor}` : 'ベスト'}
          value={formatMetric(data.best?.value)}
          hint={data.best ? `エポック ${data.best.epoch} (${data.best.mode})` : undefined}
        />
        <StatTile
          label="エポック"
          value={
            <>
              {data.epochs}
              {data.planned_epochs != null && (
                <span className="text-base font-normal text-ink-3"> / {data.planned_epochs}</span>
              )}
            </>
          }
          hint={
            data.early_stopped_epoch ? `Early Stopping (${data.early_stopped_epoch})` : undefined
          }
        />
        <StatTile
          label={running ? '経過' : '学習時間'}
          value={formatDuration(running ? data.progress?.elapsed_sec : data.duration_sec)}
          hint={
            data.final_weights && data.final_weights !== 'partial'
              ? FINAL_WEIGHTS[data.final_weights]
              : undefined
          }
        />
        <StatTile
          label="パラメータ数"
          value={data.parameter_count != null ? data.parameter_count.toLocaleString() : '—'}
        />
        <StatTile
          label="デバイス"
          value={data.device ?? '—'}
          hint={data.seed != null ? `seed ${data.seed}` : undefined}
        />
        <StatTile
          label={
            monitor
              ? `${running ? '最新' : '最終'} ${monitor}`
              : running
                ? '最新エポック'
                : '最終エポック'
          }
          value={formatMetric(monitor ? data.final_metrics[monitor] : undefined)}
          hint={others.map(([key, value]) => `${key} ${formatMetric(value)}`).join(' · ')}
        />
      </div>

      {results.data?.task && (
        <div className="mb-6">
          <TaskPanel task={results.data.task} />
        </div>
      )}
      {results.data?.notices.map((notice, index) => (
        <p key={index} className="mb-4 flex items-start gap-1.5 text-sm text-warning-text">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {notice}
        </p>
      ))}

      <div className="mb-6">
        <NotePanel key={data.id} projectId={projectId} runId={data.id} />
      </div>

      <Tabs<TabId>
        idBase={idBase}
        label="実験の詳細"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'charts', label: '学習曲線' },
          // 読む間に URL で開いたタブは, 選んだ状態を保つために数なしで出す
          ...(evaluations.length > 0 || (results.isPending && tab === 'evaluations')
            ? [
                {
                  id: 'evaluations' as const,
                  label: '評価',
                  count: results.isPending ? undefined : evaluations.length,
                },
              ]
            : []),
          ...(sampleNames > 0 || (results.isPending && tab === 'samples')
            ? [
                {
                  id: 'samples' as const,
                  label: '見本',
                  count: results.isPending ? undefined : sampleNames,
                },
              ]
            : []),
          ...(results.data?.policy || (results.isPending && tab === 'policy')
            ? [{ id: 'policy' as const, label: '方策' }]
            : []),
          ...(series.length > 0
            ? [{ id: 'images' as const, label: '画像の推移', count: series.length }]
            : []),
          { id: 'config', label: 'config', count: Object.keys(data.diff).length },
          { id: 'model', label: 'モデル' },
          { id: 'env', label: '環境' },
          { id: 'log', label: 'ログ' },
          { id: 'files', label: 'ファイル', count: data.files.length },
        ]}
      />
      <div className="mt-4" {...tabPanelProps(idBase, tab)}>
        {tab === 'charts' &&
          (history.data ? (
            <MetricCharts
              history={history.data}
              best={data.best}
              earlyStoppedEpoch={data.early_stopped_epoch}
              validInterval={validInterval(data.config)}
            />
          ) : history.error ? (
            <ErrorBox error={history.error} />
          ) : (
            <Spinner />
          ))}
        {/* 読み直しに失敗しても, 前に読めた中身を出し続ける */}
        {tab === 'evaluations' &&
          (results.data ? (
            <EvaluationsTab evaluations={evaluations} />
          ) : results.error ? (
            <ErrorBox error={results.error} />
          ) : (
            <Spinner />
          ))}
        {tab === 'samples' &&
          (results.data ? (
            <SamplesTab samples={samples} projectId={projectId} runId={data.id} />
          ) : results.error ? (
            <ErrorBox error={results.error} />
          ) : (
            <Spinner />
          ))}
        {tab === 'policy' &&
          (results.data?.policy ? (
            <PolicyTab
              policy={results.data.policy}
              outcomes={results.data.policy_outcomes}
              history={history.data}
              best={data.best}
            />
          ) : results.error ? (
            <ErrorBox error={results.error} />
          ) : (
            <Spinner />
          ))}
        {tab === 'images' && (
          <ImageTimeline series={series} projectId={projectId} runId={data.id} />
        )}
        {tab === 'config' && <ConfigTab run={data} />}
        {tab === 'model' && <ModelTab run={data} />}
        {tab === 'env' && <EnvTab run={data} projectId={projectId} />}
        {tab === 'log' &&
          (log.data ? (
            <LogTab entries={log.data} />
          ) : log.error ? (
            <ErrorBox error={log.error} />
          ) : (
            <Spinner />
          ))}
        {tab === 'files' && <FilesTab run={data} projectId={projectId} />}
      </div>
    </>
  )
}

/** 比べて選んだ実験を次の段階 (推論) で使う案内 */
function NextStageNote({ hasBundle, path }: { hasBundle: boolean; path: string | null }) {
  return (
    <details className="mb-4 text-xs text-ink-3">
      <summary className="cursor-pointer">この実験を推論の段階で使うには</summary>
      <p className="mt-1">
        {hasBundle
          ? 'この実験は推論の一式 (inference/) を持つので, ML-Provide の「実験の一覧から登録」で登録できます.'
          : 'ML-Provide の「学習の結果から作る」で, この実験のディレクトリ (重み) と, 写したモデルの定義 (model_spec.yaml) を選びます.'}{' '}
        プロジェクトの default の config の model.spec は変わりません.
      </p>
      {path && (
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <span>実験のディレクトリ:</span>
          <code className="font-mono break-all text-ink-2 select-all">{path}</code>
          <CopyButton text={path} label="実験のディレクトリの場所" />
        </p>
      )}
    </details>
  )
}
