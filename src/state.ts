// The plugin's saved state. Saved state outlives the code: read every saved value through
// upgradeState, and add each change of shape there.
import { EMPTY, upgradeLedger } from './core/ledger'
import type { Exchange, Ledger } from './core/types'

/** The storage key that holds the whole state, so one write saves every part of a turn's commit. */
export const STATE_KEY = 'state'

/** A turn read from the transcript, saved before the model runs. */
export type Turn = {
  turnId: string
  exchange: Exchange
  nextOffset: number
  /** The model runs that failed for this turn. At 3 the turn is dropped. */
  failures: number
}

export type SessionState = {
  /** The byte in the transcript where the first turn not yet applied starts. */
  offset: number
  /** Turns read but not yet applied, oldest first. */
  queue: Turn[]
  ledger: Ledger
  /** The last turn applied or dropped. A turn with this id is never applied again. */
  lastTurnId: string | null
  /** Turns dropped after 3 failed model runs: the panel shows "N turns not read". */
  unread: number
}

export type State = {
  version: 1
  terminals: Record<string, { sessionId: string }>
  sessions: Record<string, SessionState>
}

export function emptySession(): SessionState {
  return { offset: 0, queue: [], ledger: EMPTY, lastTurnId: null, unread: 0 }
}

export function emptyState(): State {
  return { version: 1, terminals: {}, sessions: {} }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function upgradeTurn(raw: unknown): Turn[] {
  if (!isObject(raw) || typeof raw.turnId !== 'string' || !isObject(raw.exchange) || typeof raw.nextOffset !== 'number') return []
  return [{ turnId: raw.turnId, exchange: raw.exchange as Exchange, nextOffset: raw.nextOffset, failures: Number(raw.failures) || 0 }]
}

function upgradeSession(raw: unknown): SessionState {
  if (!isObject(raw)) return emptySession()
  return {
    offset: typeof raw.offset === 'number' ? raw.offset : 0,
    queue: Array.isArray(raw.queue) ? raw.queue.flatMap(upgradeTurn) : [],
    ledger: isObject(raw.ledger) && Array.isArray(raw.ledger.items) ? upgradeLedger(raw.ledger as Ledger) : EMPTY,
    lastTurnId: typeof raw.lastTurnId === 'string' ? raw.lastTurnId : null,
    unread: Number(raw.unread) || 0,
  }
}

/** Reads any saved value into the current state shape. A missing or unreadable value is the empty state. */
export function upgradeState(raw: unknown): State {
  if (!isObject(raw)) return emptyState()
  const terminals: State['terminals'] = {}
  for (const [id, t] of Object.entries(isObject(raw.terminals) ? raw.terminals : {})) {
    if (isObject(t) && typeof t.sessionId === 'string') terminals[id] = { sessionId: t.sessionId }
  }
  const sessions: State['sessions'] = {}
  for (const [id, s] of Object.entries(isObject(raw.sessions) ? raw.sessions : {})) sessions[id] = upgradeSession(s)
  return { version: 1, terminals, sessions }
}
