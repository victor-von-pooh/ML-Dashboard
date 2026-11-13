/**
 * 学習のスクリプトに対応する experiment の config を探す.
 * train_hf.py なら configs/experiment/hf.yaml, 次に train_hf.yaml の順
 * (バックエンドが default の config を選ぶ規則と同じ)
 */
export function configForScript(script: string, configs: string[]): string | undefined {
  const stem = script.replace(/\.py$/, '')
  const names = stem.startsWith('train_') ? [stem.slice('train_'.length), stem] : [stem]
  return names
    .map((name) => `configs/experiment/${name}.yaml`)
    .find((path) => configs.includes(path))
}
