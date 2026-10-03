import { describe, expect, it } from 'vitest'
import { deriveRooms } from './rooms.js'

const bot = (roomId, botId, extra = {}) => ({ hostId: 'h', roomId, botId, state: 'idle', ...extra })

describe('deriveRooms', () => {
  it('splits group rooms from per-bot 1o1 rooms', () => {
    const { groupRooms, oneOnOneRooms } = deriveRooms([
      bot('alpha', 'a1', { roomName: 'Alpha Team' }),
      bot('alpha', 'a2'),
      bot('beta', 'b1'),
      bot('direct', 'd1'),
      bot('direct', 'd2'),
      bot('direct', 'd3'),
      bot('direct', 'a1'),
    ])
    expect(groupRooms.map((r) => [r.roomId, r.roomName, r.bots.length])).toEqual([
      ['alpha', 'Alpha Team', 2],
      ['beta', 'beta', 1],
    ])
    expect(oneOnOneRooms.map((r) => r.roomName)).toEqual(['d1', 'd2', 'd3', 'a1'])
    expect(oneOnOneRooms.every((r) => r.bots.length === 1)).toBe(true)
    expect(groupRooms.flatMap((r) => r.bots).every((b) => b.roomId !== 'direct')).toBe(true)
    expect(oneOnOneRooms.flatMap((r) => r.bots).every((b) => b.roomId === 'direct')).toBe(true)
    expect(new Set(oneOnOneRooms.map((r) => r.id)).size).toBe(4)
  })
})
