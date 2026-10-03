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
