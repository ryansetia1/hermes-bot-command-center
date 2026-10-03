// Hermes desktop pet sheets: 8 columns x 9 rows of 192x208 frames, one row per animation (agent/pet/constants.py).
const SHEET_ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
const ROW_FOR_STATE = { idle: 'idle', working: 'running', speaking: 'waving', error: 'failed', unobserved: 'idle' }

export const isSheet = (pet) => /^\/hermes-pets\/[^/]+\/[^/]+\/spritesheet\./.test(pet?.url ?? '')

export const sheetRow = (state) => SHEET_ROWS.indexOf(ROW_FOR_STATE[state] ?? 'idle')

// ?v= busts the browser cache when the pet changes, so the sprite follows without a reload.
export const petSrc = (pet) => `${pet.url}?v=${encodeURIComponent(pet.version ?? '')}`
