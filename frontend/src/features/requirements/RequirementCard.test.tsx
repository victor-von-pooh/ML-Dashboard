import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Requirement } from '../../api/client'
import { describeMissing } from '../../lib/requirements'
import { RequirementCard } from './RequirementCard'

const rl: Requirement = {
  name: 'rl',
  description: '強化学習の環境',
  checks: [{ kind: 'module', name: 'gymnasium', ok: false, error: null }],
  match: 'all',
  available: false,
  install: {
    kind: 'pip',
    extra: 'rl',
    packages: ['gymnasium>=1.0'],
    url: 'https://gymnasium.farama.org/',
    command: 'pip install "gymnasium>=1.0"',
    extra_command: 'pip install -e "./ML-Found[rl]"',
  },
  note: null,
}

const ros2: Requirement = {
  name: 'ros2',
  description: 'ROS 2',
  checks: [
    { kind: 'module', name: 'rclpy', ok: false, error: null },
    { kind: 'command', name: 'ros2', ok: false, error: null },
  ],
  match: 'any',
  available: false,
  install: {
    kind: 'guide',
    extra: null,
    packages: [],
    url: 'javascript:alert(1)',
    command: null,
    extra_command: null,
  },
  note: 'pip では入らない',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RequirementCard', () => {
  it('足りない機能の状態, 次の一手のコマンドと説明のリンクを出し, コピーできる', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<RequirementCard requirement={rl} />)
    expect(screen.getByText('足りない')).toBeInTheDocument()
    expect(screen.getByText('次の一手')).toBeInTheDocument()
    expect(screen.getByText('pip install "gymnasium>=1.0"')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /説明/ })).toHaveAttribute(
      'href',
      'https://gymnasium.farama.org/',
    )
    fireEvent.click(screen.getByRole('button', { name: 'rl の pip のコマンド をコピー' }))
    expect(await screen.findByText('rl の pip のコマンド をコピーしました')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('pip install "gymnasium>=1.0"')
  })

  it('コピーできない環境では選んでコピーするように知らせる', async () => {
    vi.stubGlobal('navigator', {})
    render(<RequirementCard requirement={rl} />)
    fireEvent.click(screen.getByRole('button', { name: 'rl の pip のコマンド をコピー' }))
    expect(await screen.findByText(/選んでコピーしてください/)).toBeInTheDocument()
  })

  it('pip で入らない機能は公式の手順を案内し, http でない URL はリンクにしない', () => {
    render(<RequirementCard requirement={{ ...ros2, available: null }} />)
    expect(screen.getByText('確かめられない')).toBeInTheDocument()
    expect(screen.getByText(/pip では入りません/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('要るもの (どれか 1 つ)')).toBeInTheDocument()
    expect(screen.getByText('補足: pip では入らない')).toBeInTheDocument()
  })

  it('版が古い時は「版が古い」と入っている版と下限を出し, 無い時と版を読めない時は今のまま', () => {
    const old: Requirement = {
      ...rl,
      checks: [
        {
          kind: 'module',
          name: 'gymnasium',
          ok: false,
          error: '版 0.29.1 は古い. 1.0 以上が要る',
          version: '0.29.1',
          min_version: '1.0',
        },
      ],
    }
    const { unmount } = render(<RequirementCard requirement={old} />)
    expect(screen.getAllByText('版が古い')[0]).toBeInTheDocument()
    expect(screen.getByText('版が古い (gymnasium 0.29.1, 1.0 以上が要る)')).toBeInTheDocument()
    expect(screen.queryByText('足りない')).toBeNull()
    expect(screen.queryByText('無い')).toBeNull()
    unmount()

    // 版を読めない時は確かめが通るので「ある」, 版の無い古い ML-Found の結果は「無い」
    const unread: Requirement = {
      ...rl,
      available: true,
      checks: [
        {
          kind: 'module',
          name: 'gymnasium',
          ok: true,
          error: '版を読めないので 1.0 以上かを確かめていない',
          version: null,
          min_version: '1.0',
        },
      ],
    }
    const second = render(<RequirementCard requirement={unread} />)
    expect(screen.getByText('入っている')).toBeInTheDocument()
    expect(screen.getByText('ある')).toBeInTheDocument()
    second.unmount()
    render(<RequirementCard requirement={rl} />)
    expect(screen.getByText('足りない')).toBeInTheDocument()
    expect(screen.getByText('無い')).toBeInTheDocument()
  })
})

describe('describeMissing', () => {
  const old: Requirement = {
    ...rl,
    checks: [
      {
        kind: 'module',
        name: 'gymnasium',
        ok: false,
        error: null,
        version: '0.29.1',
        min_version: '1.0',
      },
    ],
  }

  it('起動の画面の文を, 入っていない機能と版の古い機能に分ける', () => {
    expect(describeMissing([rl]).summary).toBe('rl が足りないので開始できません')
    expect(describeMissing([rl]).title).toBe('足りない追加の依存があるので開始できません')
    const onlyOld = describeMissing([old])
    expect(onlyOld.summary).toBe('rl の版が古いので開始できません')
    expect(onlyOld.title).toBe('版の古い追加の依存があるので開始できません')
    expect(onlyOld.text).toBe(
      'config の requires に書いた機能のうち, rl は入っている版が古いです (gymnasium 0.29.1, 1.0 以上が要る).',
    )
    const both = describeMissing([ros2, old])
    expect(both.summary).toBe('ros2 が足りず, rl の版が古いので開始できません')
    expect(both.title).toBe('足りないか版の古い追加の依存があるので開始できません')
    // 混ざった時も機能の名前は 1 回だけ, 言い回しはバックエンドの起動を止める文とそろえる
    expect(both.text).toBe(
      'config の requires に書いた機能のうち, ros2 がプロジェクトの Python に入っておらず, rl は入っている版が古いです (gymnasium 0.29.1, 1.0 以上が要る).',
    )
  })
})
