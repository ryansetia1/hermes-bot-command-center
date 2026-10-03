import { describe, expect, it } from 'vitest'
import { isSheet, petSrc, sheetRow } from './petSprite.js'

describe('petSprite', () => {
  it('maps bot state to the sheet row', () => {
    expect(['idle', 'working', 'speaking', 'error', 'unobserved', 'nope'].map(sheetRow)).toEqual([0, 7, 3, 5, 0, 0])
  })

  it('only treats collector-served sheets as sheets', () => {
    expect(isSheet({ url: '/hermes-pets/elio/ninjacat/spritesheet.webp' })).toBe(true)
    expect(isSheet({ url: '/pets/atlas-v1.png' })).toBe(false)
    expect(isSheet(null)).toBe(false)
  })

  it('changes the src when the version changes', () => {
    const pet = { url: '/hermes-pets/a/b/spritesheet.webp', version: '1' }
    expect(petSrc(pet)).not.toBe(petSrc({ ...pet, version: '2' }))
  })
})
