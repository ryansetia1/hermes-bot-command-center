// Sprite positions are percentages of the scene floor (the sprite's centre point).
export const FLOOR = { minX: 8, maxX: 92, minY: 22, maxY: 86 }

export function wanderTarget(rand = Math.random) {
  return {
    x: FLOOR.minX + rand() * (FLOOR.maxX - FLOOR.minX),
    y: FLOOR.minY + rand() * (FLOOR.maxY - FLOOR.minY),
  }
}

// Evenly spread starting spots (grid cell centres) so bots never start stacked.
export function spreadPositions(count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.6)))
  const rows = Math.max(1, Math.ceil(count / cols))
  return Array.from({ length: count }, (_, i) => ({
    x: FLOOR.minX + (((i % cols) + 0.5) / cols) * (FLOOR.maxX - FLOOR.minX),
    y: FLOOR.minY + ((Math.floor(i / cols) + 0.5) / rows) * (FLOOR.maxY - FLOOR.minY),
  }))
}
