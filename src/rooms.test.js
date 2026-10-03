import { describe, expect, it } from 'vitest'
import { deriveRooms, mergeRoster } from './rooms.js'

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

describe('mergeRoster', () => {
  const roster = {
    rooms: [{ roomId: 'r1', name: 'Build Room', members: ['a', 'b'] }],
    bots: [{ botId: 'a', title: 'Atlas' }, { botId: 'b', title: 'Bea' }],
  }

  it('seeds idle group members and one 1o1 room per bot', () => {
    const { groupRooms, oneOnOneRooms } = deriveRooms(mergeRoster([], roster))
    expect(groupRooms.map((r) => [r.roomName, r.bots.map((b) => b.botId)])).toEqual([['Build Room', ['a', 'b']]])
    expect(oneOnOneRooms.map((r) => r.roomName)).toEqual(['a', 'b'])
    expect(groupRooms[0].bots.every((b) => b.state === 'idle')).toBe(true)
  })

  it('lets live entities replace their seeded tile instead of duplicating it', () => {
    const live = [bot('r1', 'a', { state: 'working' }), bot('direct', 'b', { state: 'speaking' })]
    const merged = mergeRoster(live, roster)
    expect(merged.filter((e) => e.roomId === 'r1' && e.botId === 'a')).toEqual([live[0]])
    expect(merged.filter((e) => e.roomId === 'direct' && e.botId === 'b')).toEqual([live[1]])
    expect(merged).toHaveLength(4)
  })
})
