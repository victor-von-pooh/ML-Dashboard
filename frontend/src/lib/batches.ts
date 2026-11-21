import type { BatchInfo, JobInfo, ModelSpecInfo } from '../api/client'
import { MAX_COMPARE } from './metrics'

/** 候補のジョブの, どの定義の何番目かの言葉 (ジョブの画面に添える) */
export function batchLabels(batches: BatchInfo[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const batch of batches) {
    batch.candidates.forEach((candidate, index) => {
      if (candidate.job_id) {
        labels.set(
          candidate.job_id,
          `${candidate.name} (${index + 1} / ${batch.candidates.length})`,
        )
      }
    })
  }
  return labels
}

/** まとまりの候補のジョブが残した実験と, 比較の画面の URL (比べられる数まで) */
export function compareCandidates(
  batch: BatchInfo,
  jobs: JobInfo[],
): { runIds: string[]; url: string } {
  const runOf = new Map(jobs.map((job) => [job.id, job.run_id]))
  const runIds = batch.candidates
    .map((candidate) => (candidate.job_id ? runOf.get(candidate.job_id) : null))
    .filter((id): id is string => Boolean(id))
  const query = new URLSearchParams()
  for (const id of runIds.slice(0, MAX_COMPARE)) query.append('run', id)
  return {
    runIds,
    url: `/projects/${encodeURIComponent(batch.project_id)}/compare?${query.toString()}`,
  }
}

/** まとまりの状態の言葉 (取りやめたまとまりは「取りやめた」) */
export function batchState(batch: BatchInfo): string {
  if (!batch.finished) return '進めている途中'
  const cancelled = batch.candidates.some((candidate) => candidate.state === 'cancelled')
  return cancelled ? '取りやめた' : '終わった'
}

/**
 * 起動に使う候補. 選んだときと違うスクリプトか default なら選び直し (空), 一覧から消えたか
 * 選べなくなった定義は外す (選んだ順は保つ)
 */
export function chosenCandidates(
  chosen: { key: string; paths: string[] },
  key: string,
  specs: ModelSpecInfo[],
): string[] {
  if (chosen.key !== key) return []
  const selectable = new Set(specs.filter((spec) => spec.reason == null).map((spec) => spec.path))
  return chosen.paths.filter((path) => selectable.has(path))
}
