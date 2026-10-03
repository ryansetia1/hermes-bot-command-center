import { describe, expect, it } from 'vitest'
import { isUnread } from './readMarks.js'

describe('isUnread', () => {
  it('is unread only when the message is newer than what was read', () => {
    expect(isUnread(undefined, undefined)).toBe(false)
    expect(isUnread('2026-01-01T00:00:10Z', undefined)).toBe(true)
    expect(isUnread('2026-01-01T00:00:10Z', '2026-01-01T00:00:10Z')).toBe(false)
    expect(isUnread('2026-01-01T00:00:20Z', '2026-01-01T00:00:10Z')).toBe(true)
  })
})
