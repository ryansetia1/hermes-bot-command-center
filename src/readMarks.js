import { useCallback, useState } from 'react'

const STORAGE_KEY = 'hermes-read-marks'

// A bot's message is unread when it is newer than the message the user last opened.
export const isUnread = (messageAt, readAt) => Boolean(messageAt) && Date.parse(messageAt) > (readAt ? Date.parse(readAt) : 0)

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {} } catch { return {} }
}

// Per-entity-key read state, kept client-side only (localStorage when available).
export function useReadMarks() {
  const [marks, setMarks] = useState(load)
  const markRead = useCallback((key, messageAt) => setMarks((prev) => {
    if (prev[key] === messageAt) return prev
    const next = { ...prev, [key]: messageAt }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode: in-memory only */ }
    return next
  }), [])
  return [marks, markRead]
}
