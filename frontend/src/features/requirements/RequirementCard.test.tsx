import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Requirement } from '../../api/client'
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
})
