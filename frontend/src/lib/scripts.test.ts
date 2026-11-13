import { describe, expect, it } from 'vitest'

import { configForScript } from './scripts'

const configs = [
  'configs/experiment/train.yaml',
  'configs/experiment/hf.yaml',
  'configs/experiment/train_big.yaml',
  'configs/experiment/examples/hf_smoke.yaml',
]

describe('configForScript', () => {
  it('train.py は train.yaml', () => {
    expect(configForScript('train.py', configs)).toBe('configs/experiment/train.yaml')
  })

  it('train_hf.py は先頭の train_ を除いた hf.yaml', () => {
    expect(configForScript('train_hf.py', configs)).toBe('configs/experiment/hf.yaml')
  })

  it('除いた名前が無ければスクリプトと同じ名前', () => {
    expect(configForScript('train_big.py', configs)).toBe('configs/experiment/train_big.yaml')
  })

  it('対応が無ければ undefined (examples の中は探さない)', () => {
    expect(configForScript('train_pinn.py', configs)).toBeUndefined()
    expect(configForScript('train_smoke.py', configs)).toBeUndefined()
    expect(
      configForScript('trainer.py', [...configs, 'configs/experiment/trainer.yaml']),
    ).toBeUndefined()
    expect(configForScript('train_.py', [...configs, 'configs/experiment/.yaml'])).toBeUndefined()
  })
})
