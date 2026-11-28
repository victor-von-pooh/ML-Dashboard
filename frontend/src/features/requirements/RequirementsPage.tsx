import { RefreshCw } from 'lucide-react'
import { Link, useParams } from 'react-router'

import { useProject, useRecheckRequirements, useRequirements } from '../../api/hooks'
import { Button, Card, ErrorBox, PageHeader, Spinner, StageCrumbs } from '../../components/ui'
import { formatDateTime } from '../../lib/format'
import { RequirementCard } from './RequirementCard'

/** プロジェクトの Python で確かめた, ML-Found の追加の依存のカードの一覧 */
export function RequirementsPage() {
  const { projectId = '' } = useParams()
  const project = useProject(projectId)
  const report = useRequirements(projectId)
  const recheck = useRecheckRequirements(projectId)

  return (
    <>
      <PageHeader
        breadcrumb={
          <StageCrumbs
            links={[{ to: `/projects/${projectId}`, label: project.data?.name ?? projectId }]}
          />
        }
        title="追加の依存"
        subtitle="ML-Found の本体に含めない機能 (強化学習の環境, MuJoCo, ROS 2, CUDA など) が入っているかと入れ方"
        actions={
          <>
            <Link
              to={`/projects/${projectId}/launch`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
            >
              学習を起動
            </Link>
            <Button
              icon={RefreshCw}
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending || report.isPending}
            >
              {recheck.isPending ? '確かめています' : '確かめ直す'}
            </Button>
          </>
        }
      />

      {report.isPending ? (
        <Spinner label="プロジェクトの Python で確かめています" />
      ) : report.error ? (
        <ErrorBox error={report.error} live={false} />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-ink-3">
            確かめた Python: <span className="font-mono break-all">{report.data.python}</span>
            {' · '}
            {formatDateTime(report.data.checked_at)}. 入れるときは, この Python
            の環境でコマンドを実行します. 入れた後は「確かめ直す」を押します.
          </p>
          {recheck.error && <ErrorBox error={recheck.error} />}
          {report.data.error && (
            <ErrorBox error={report.data.error} live={false}>
              <p className="mt-1 text-xs text-ink-2">
                確かめられない間も学習は起動できます.
                足りなければ学習のスクリプトが入れ方を示して止まります.
              </p>
            </ErrorBox>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {report.data.requirements.map((requirement) => (
              <RequirementCard key={requirement.name} requirement={requirement} />
            ))}
          </div>
          <Card title="学習に要る機能を config に書く">
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                default の config の一番上に <code className="font-mono">requires</code> を書くと,
                足りない機能があるときに学習の起動の画面で開始のボタンが押せなくなり,
                次の一手が出ます.
              </p>
              <pre className="rounded-md bg-surface-2 px-3 py-2 font-mono text-xs">
                {'# configs/default/train.yaml\nrequires: [rl]'}
              </pre>
              <p className="text-xs text-ink-3">
                学習ごとに変える場合は, default に <code className="font-mono">requires: []</code>{' '}
                を書き, experiment の config の値で替えます (ML-Found は default に無い項目を
                experiment の config に書けません).
              </p>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}
