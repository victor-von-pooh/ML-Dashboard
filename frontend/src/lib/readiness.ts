import type { ConfigPath, EnvironmentJob, ProjectReadiness } from '../api/client'

/** 準備の 1 項目の状態. ok = そろっている, missing = 足りない, unknown = 分からない */
export type ReadinessState = 'ok' | 'missing' | 'unknown'

export type ReadinessItem = {
  label: string
  state: ReadinessState
  text: string
  // 次の一手
  hint?: string
  // 辿った先のパスか Python
  detail?: string
}

/** config に書いたパスの項目 */
function pathItem(label: string, status: ConfigPath, hint: string): ReadinessItem {
  if (status.error) return { label, state: 'unknown', text: status.error }
  if (status.value == null) {
    return {
      label,
      state: 'unknown',
      text: `default の config に ${status.key} がありません`,
      hint: `学習のスクリプトが読む場所を ${status.key} に書くと, ここで確かめられます`,
    }
  }
  if (status.exists) {
    return { label, state: 'ok', text: 'あります', detail: status.path ?? undefined }
  }
  return { label, state: 'missing', text: 'まだありません', hint, detail: status.path ?? undefined }
}

/** 環境の項目 */
function environmentItem(readiness: ProjectReadiness): ReadinessItem {
  const label = '学習の環境'
  const detail = readiness.target_python
  if (!readiness.environment_exists) {
    return readiness.managed
      ? {
          label,
          state: 'missing',
          text: 'プロジェクトの .venv がまだありません',
          hint: '「環境を作る」で .venv を作り, ML-Found と要る機能を入れます',
          detail,
        }
      : {
          label,
          state: 'missing',
          text: '登録した Python が見つかりません',
          hint: 'プロジェクトのディレクトリを付け替えるか, 登録し直してください',
          detail,
        }
  }
  if (readiness.ml_found === false) {
    return {
      label,
      state: 'missing',
      text: 'ML-Found が入っていません',
      hint: '「足りないものを入れる」で入れます',
      detail,
    }
  }
  if (readiness.missing.length > 0) {
    return {
      label,
      state: 'missing',
      text: `足りない機能: ${readiness.missing.join(', ')}`,
      hint:
        readiness.commands.length > 0
          ? '「足りないものを入れる」で pip で入るものを入れます'
          : undefined,
      detail,
    }
  }
  if (readiness.outdated.length > 0) {
    return {
      label,
      state: 'unknown',
      text: `ML-Found が古い版なので ${readiness.outdated.join(', ')} を確かめられません`,
      hint: '「足りないものを入れる」で ML-Found を入れ直します',
      detail,
    }
  }
  if (readiness.ml_found == null) {
    return { label, state: 'unknown', text: '入っているかを確かめられませんでした', detail }
  }
  if (readiness.switch_python) {
    return {
      label,
      state: 'missing',
      text: '学習に使う Python がまだプロジェクトの .venv ではありません',
      hint: '「.venv を使う」で付け替えます',
      detail,
    }
  }
  const names =
    readiness.requires.length > 0 ? ` と要る機能 (${readiness.requires.join(', ')})` : ''
  return { label, state: 'ok', text: `ML-Found${names}が入っています`, detail }
}

/** 学習の準備の項目 (データセット, モデルの定義, 環境の順) */
export function readinessItems(readiness: ProjectReadiness): ReadinessItem[] {
  const items = [
    pathItem(
      'データセット',
      readiness.dataset,
      'データの分析 (ML-Fathom) でデータセットをこの場所に書き出します',
    ),
  ]
  if (readiness.model_spec) {
    items.push(
      pathItem(
        'モデルの定義',
        readiness.model_spec,
        'モデルの作成 (ML-CreateArchitecture) で定義をこの場所に置きます',
      ),
    )
  }
  items.push(environmentItem(readiness))
  return items
}

/** 環境を作るボタンの文 */
export function environmentAction(readiness: ProjectReadiness): string | null {
  if (readiness.commands.length === 0) return readiness.switch_python ? '.venv を使う' : null
  return readiness.environment_exists ? '足りないものを入れる' : '環境を作る'
}

/** 環境のジョブの状態の文 */
export const JOB_STATUS: Record<EnvironmentJob['status'], string> = {
  running: '進めています',
  succeeded: '終わりました',
  failed: '失敗しました',
  interrupted: '途中で止まりました (ダッシュボードを起動し直したため)',
}
