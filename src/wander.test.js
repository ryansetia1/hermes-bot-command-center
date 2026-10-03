import { describe, expect, it } from 'vitest'
import { FLOOR, spreadPositions, wanderTarget } from './wander.js'

const inFloor = ({ x, y }) => x >= FLOOR.minX && x <= FLOOR.maxX && y >= FLOOR.minY && y <= FLOOR.maxY

describe('wanderTarget', () => {
  it('stays inside the floor for any random value', () => {
    for (const r of [0, 0.5, 0.999999, 1]) expect(inFloor(wanderTarget(() => r))).toBe(true)
    for (let i = 0; i < 200; i++) expect(inFloor(wanderTarget())).toBe(true)
  })
})

describe('spreadPositions', () => {
  it('returns distinct in-bounds spots', () => {
    for (const n of [1, 2, 4, 9]) {
      const spots = spreadPositions(n)
      expect(spots).toHaveLength(n)
      expect(spots.every(inFloor)).toBe(true)
      expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size).toBe(n)
    }
  })
})
