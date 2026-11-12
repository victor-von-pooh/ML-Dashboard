import { describe, expect, it } from 'vitest'

import type { RunFile } from '../api/client'
import { frameAtOrBefore, groupImageSeries, sharedImageSeries } from './images'

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

  it('番号だけのファイルはディレクトリの名前でまとめる', () => {
    const series = groupImageSeries([
      image('samples/001.png'),
      image('samples/002.png'),
      image('0.png'),
      image('1.png'),
    ])
    expect(series.map((item) => item.name)).toEqual(['(画像)', 'samples'])
  })
})

describe('sharedImageSeries', () => {
  it('2 つ以上の実験にある並びだけを, 番号をそろえて返す', () => {
    const first = groupImageSeries([
      image('samples/epoch_001.png'),
      image('samples/epoch_005.png'),
      image('recon/epoch_001.png'),
      image('recon/epoch_002.png'),
    ])
    const second = groupImageSeries([
      image('samples/epoch_001.png'),
      image('samples/epoch_010.png'),
    ])
    const shared = sharedImageSeries([first, second, []])
    expect(shared.map((item) => item.name)).toEqual(['samples/epoch'])
    expect(shared[0]?.steps).toEqual([1, 5, 10])
    expect(shared[0]?.frames[0]?.get(5)).toBe('samples/epoch_005.png')
    expect(shared[0]?.frames[1]?.get(5)).toBeUndefined()
    expect(shared[0]?.frames[2]).toBeNull()
  })
})

describe('frameAtOrBefore', () => {
  it('番号以下で最も近い画像を返し, 無ければ null', () => {
    const frames = new Map([
      [10, 'b.png'],
      [1, 'a.png'],
    ])
    expect(frameAtOrBefore(frames, 10)).toEqual({ step: 10, path: 'b.png' })
    expect(frameAtOrBefore(frames, 7)).toEqual({ step: 1, path: 'a.png' })
    expect(frameAtOrBefore(frames, 0)).toBeNull()
  })

  it('1 枚だけの並びも minFrames で数える', () => {
    expect(groupImageSeries([image('samples/epoch_001.png')], 1)).toHaveLength(1)
  })
})
