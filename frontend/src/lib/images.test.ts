import { describe, expect, it } from 'vitest'

import type { RunFile } from '../api/client'
import { groupImageSeries } from './images'

function image(path: string): RunFile {
  return { path, size: 1, kind: 'image' }
}

describe('groupImageSeries', () => {
  it('番号の付いた画像を並びごとに番号の順でまとめる', () => {
    const series = groupImageSeries([
      image('samples/epoch_010.png'),
      image('samples/epoch_002.png'),
      image('recon/epoch_001.png'),
      image('recon/epoch_005.png'),
      image('recon/best.png'),
      image('loss_curve.png'),
      image('step-1.jpg'),
      image('step-20.jpg'),
      { path: 'samples/epoch_003.pt', size: 1, kind: 'checkpoint' },
    ])
    expect(series).toEqual([
      {
        name: 'recon/epoch',
        frames: [
          { path: 'recon/epoch_001.png', step: 1 },
          { path: 'recon/epoch_005.png', step: 5 },
        ],
      },
      {
        name: 'samples/epoch',
        frames: [
          { path: 'samples/epoch_002.png', step: 2 },
          { path: 'samples/epoch_010.png', step: 10 },
        ],
      },
      {
        name: 'step',
        frames: [
          { path: 'step-1.jpg', step: 1 },
          { path: 'step-20.jpg', step: 20 },
        ],
      },
    ])
  })

  it('1 枚だけの並びと番号の無い画像は返さない', () => {
    expect(groupImageSeries([image('samples/epoch_001.png'), image('samples.png')])).toEqual([])
  })
})
