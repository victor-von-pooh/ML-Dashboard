import { useEffect, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import { useHistory, useLog, useProject, useRun } from '../../api/hooks'
import { ErrorBox, PageHeader, Spinner, StatTile, StatusBadge, Tabs } from '../../components/ui'
import { tabPanelProps, useStableId } from '../../lib/a11y'
import { formatDateTime, formatDuration, formatMetric } from '../../lib/format'
import { groupImageSeries } from '../../lib/images'
import type { RunFile } from '../../api/client'
import { ImageTimeline } from './ImageTimeline'
import { MetricCharts } from './MetricCharts'
import { NotePanel } from './NotePanel'
import { ConfigTab, EnvTab, FilesTab, LogTab, ModelTab } from './RunTabs'

// 同じファイルの一覧からは同じ並びを返し, 描画のたびに作り直さないようにする
const seriesCache = new WeakMap<RunFile[], ReturnType<typeof groupImageSeries>>()
function seriesOf(files: RunFile[]) {
  const cached = seriesCache.get(files)
  if (cached) return cached
  const series = groupImageSeries(files)
  seriesCache.set(files, series)
  return series
}

const TAB_IDS = ['charts', 'images', 'config', 'model', 'env', 'log', 'files'] as const
type TabId = (typeof TAB_IDS)[number]

/** URL の値を画面のタブに直す */
function toTab(value: string | null): TabId {
  return TAB_IDS.find((id) => id === value) ?? 'charts'
}

export function RunDetailPage() {
  const { projectId = '', '*': runId = '' } = useParams()
  const project = useProject(projectId)
  const run = useRun(projectId, runId)
  const running = run.data?.status === 'running'
  const history = useHistory(projectId, runId, running)

  // 学習が終わったら, 最後のエポックの記録を読むためにもう一度読み直す
  const wasRunning = useRef(false)
  const refetchHistory = history.refetch
  useEffect(() => {
    if (wasRunning.current && !running) void refetchHistory()
    wasRunning.current = running
  }, [running, refetchHistory])
  const [params, setParams] = useSearchParams()
  const requestedTab = toTab(params.get('tab'))
  const log = useLog(projectId, runId, requestedTab === 'log')
  const idBase = useStableId('run')

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
  const tab: TabId = requestedTab === 'images' && series.length === 0 ? 'charts' : requestedTab

  const monitor = data.best?.monitor
  const others = Object.entries(data.final_metrics).filter(
    ([key]) => key.startsWith('valid/') && key !== monitor,
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
          </span>
        }
      />
      {data.error && <ErrorBox error={data.error} live={false} />}

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
        <StatTile label="学習時間" value={formatDuration(data.duration_sec)} />
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
          label={monitor ? `最終 ${monitor}` : '最終エポック'}
          value={formatMetric(monitor ? data.final_metrics[monitor] : undefined)}
          hint={others.map(([key, value]) => `${key} ${formatMetric(value)}`).join(' · ')}
        />
      </div>

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
            />
          ) : history.error ? (
            <ErrorBox error={history.error} />
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
