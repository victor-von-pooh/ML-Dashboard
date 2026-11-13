/**
 * 学習のスクリプトに対応する experiment の config を探す.
 * train_hf.py なら configs/experiment/hf.yaml, 次に train_hf.yaml の順.
 * 名前の導き方は, バックエンドが default の config (configs/default/) を選ぶ規則と同じ
 */
export function configForScript(script: string, configs: string[]): string | undefined {
  // train_ で始まる名前だけを対応させ, train.py は train.yaml (バックエンドの既定と同じ)
  const stem = script.replace(/\.py$/, '')
  const rest = stem.slice('train_'.length)
  const names = stem.startsWith('train_') && rest ? [rest, stem] : stem === 'train' ? ['train'] : []
  return names
    .map((name) => `configs/experiment/${name}.yaml`)
    .find((path) => configs.includes(path))
}
