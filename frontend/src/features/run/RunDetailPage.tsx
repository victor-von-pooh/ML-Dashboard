import { useState } from 'react'
import { Link, useParams } from 'react-router'

import { useHistory, useLog, useProject, useRun } from '../../api/hooks'
import { ErrorBox, PageHeader, Spinner, StatTile, StatusBadge, Tabs } from '../../components/ui'
import { formatDateTime, formatDuration, formatMetric } from '../../lib/format'
import { MetricCharts } from './MetricCharts'
import { ConfigTab, EnvTab, FilesTab, LogTab, ModelTab } from './RunTabs'

type TabId = 'charts' | 'config' | 'model' | 'env' | 'log' | 'files'

export function RunDetailPage() {
  const { projectId = '', '*': runId = '' } = useParams()
  const project = useProject(projectId)
  const run = useRun(projectId, runId)
  const history = useHistory(projectId, runId)
  const [tab, setTab] = useState<TabId>('charts')
  const log = useLog(projectId, runId, tab === 'log')

  if (run.isPending) return <Spinner />
  if (run.error) return <ErrorBox error={run.error} />
  const data = run.data

  const monitor = data.best?.monitor
  const finalMetrics = Object.entries(data.final_metrics).filter(([key]) =>
    key.startsWith('valid/'),
  )

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
              {project.data?.name ?? projectId}
            </Link>
          </>
        }
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
          label={monitor ? `最後のエポックの ${monitor}` : '最後のエポック'}
          value={formatMetric(monitor ? data.final_metrics[monitor] : undefined)}
          hint={finalMetrics
            .filter(([key]) => key !== monitor)
            .map(([key, value]) => `${key} ${formatMetric(value)}`)
            .join(' · ')}
        />
      </div>

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'charts', label: '学習曲線' },
          { id: 'config', label: 'config', count: Object.keys(data.diff).length },
          { id: 'model', label: 'モデル' },
          { id: 'env', label: '環境' },
          { id: 'log', label: 'ログ' },
          { id: 'files', label: 'ファイル', count: data.files.length },
        ]}
      />
      <div className="mt-4">
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
