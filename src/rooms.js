export const DIRECT_ROOM_ID = 'direct'

// Derives lobby rooms from the presence.v1 entity list.
// 1o1 = roomId 'direct' (one room per bot); group = any other roomId.
export function deriveRooms(entities) {
  const groups = new Map()
  const oneOnOneRooms = []
  for (const entity of entities) {
    const roomId = entity.roomId || DIRECT_ROOM_ID
    if (roomId === DIRECT_ROOM_ID) {
      oneOnOneRooms.push({ id: `${roomId}:${entity.hostId}:${entity.botId}`, roomId, roomName: entity.botId, bots: [entity] })
      continue
    }
    const room = groups.get(roomId) || { id: roomId, roomId, roomName: roomId, bots: [] }
    if (entity.roomName) room.roomName = entity.roomName
    room.bots.push(entity)
    groups.set(roomId, room)
  }
  return { groupRooms: [...groups.values()], oneOnOneRooms }
}

// Seeds live entities with idle placeholders from the Hermes roster; live entities (matched by roomId + botId) win.
export function mergeRoster(entities, roster) {
  const seen = new Set(entities.map((entity) => `${entity.roomId || DIRECT_ROOM_ID}:${entity.botId}`))
  const hostId = entities[0]?.hostId ?? 'default'
  const seeded = []
  const seed = (roomId, roomName, botId) => {
    if (seen.has(`${roomId}:${botId}`)) return
    seen.add(`${roomId}:${botId}`)
    seeded.push({ hostId, roomId, roomName, botId, state: 'idle', activity: 'Waiting for the next task', pet: { slug: botId, version: '1', url: `/hermes-avatars/${botId}/avatar.png` } })
  }
  for (const room of roster.rooms ?? []) room.members.forEach((botId) => seed(room.roomId, room.name, botId))
  for (const bot of roster.bots ?? []) seed(DIRECT_ROOM_ID, bot.botId, bot.botId)
  return [...entities, ...seeded]
}
