import type { BatchInfo } from '../api/client'

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
