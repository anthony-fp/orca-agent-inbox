// The plugin's saved state. Saved state outlives the code: read every saved value through
// upgradeState, and add each change of shape there.
import { EMPTY, upgradeLedger } from './core/ledger'
import type { Exchange, Ledger, Told } from './core/types'

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
  /** The last press on each open row, by item id, so its label outlives a worker restart (plan T7). */
  presses: Record<string, PressLabel>
  /** The last launch, `done` or press for the session. Pruning drops a session with no open rows untouched for 7 days. */
  touchedAt: number
  /**
   * The turn a tool call is stamped with: raised by 1 at each prompt-start (src/socket.ts), before the transcript
   * shows the prompt. The stamp is the higher of this and `ledger.turn`, so the transcript's count can catch it up.
   */
  activeTurn: number
  /** The inbox text the agent last read beside a prompt, and the closed items it was told of, as the inbox skill keeps them. */
  told: Told
  /**
   * False when the last launch got no inbox tools, because its command set its own MCP, system prompt or settings
   * flags (plan T11): the panel says so on the agent's section.
   */
  tools: boolean
  /**
   * The session's transcript, `~/.claude/projects/<folder>/<session id>.jsonl`, once found by its session id. Null
   * until the file exists: Claude Code writes it at the first prompt.
   */
  transcript: string | null
  /** The session's folder, for its plan file: the first `cwd` in its transcript, or the prompt hook's `cwd`. */
  cwd: string | null
}

/**
 * A press's result on its row. sending: typed into the terminal, no prompt seen yet. answered: the prompt showed in
 * the transcript. held: the agent was not waiting, so nothing was sent. undelivered: the send's result is not certain.
 * The plugin never sends a held or undelivered answer again by itself.
 */
export type PressLabel = {
  state: 'sending' | 'answered' | 'held' | 'undelivered'
  /**
   * What the press sent: a question's option, typed words on any row, a step that asks the agent to run a command,
   * or a finding's Fix or File issue. Only an option closes its row when its turn runs. A label saved before presses
   * kept this is an answer.
   */
  kind: 'answer' | 'reply' | 'step' | 'fix' | 'issue'
  /** The option or words the person gave, for the row's close when the answering turn runs, or the button's label. */
  answer: string
  /** The message typed into the terminal, or that Copy copies. */
  text: string
  at: number
  /** The transcript's byte length when the send started: the answer's prompt starts at or after it. */
  from?: number
  /** The uuid of the prompt that delivered the answer: the turn that answers the press. */
  turnId?: string
}

export type State = {
  version: 1
  /** Each tracked terminal's session. A terminal goes when its session is pruned. */
  terminals: Record<string, { sessionId: string }>
  sessions: Record<string, SessionState>
}

export function emptySession(now = 0): SessionState {
  return { offset: 0, queue: [], ledger: EMPTY, lastTurnId: null, unread: 0, presses: {}, touchedAt: now, activeTurn: 0, told: { inbox: null, closed: [] }, tools: true, transcript: null, cwd: null }
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

const LABEL_STATES: PressLabel['state'][] = ['sending', 'answered', 'held', 'undelivered']
const LABEL_KINDS: PressLabel['kind'][] = ['answer', 'reply', 'step', 'fix', 'issue']

/** A label saved while its send was out reads "Not delivered": the watch that would confirm it ended with the worker. */
function upgradeLabel(raw: unknown): PressLabel[] {
  if (!isObject(raw) || !LABEL_STATES.includes(raw.state as PressLabel['state']) || typeof raw.text !== 'string') return []
  const label: PressLabel = {
    state: raw.state === 'sending' ? 'undelivered' : (raw.state as PressLabel['state']),
    kind: LABEL_KINDS.includes(raw.kind as PressLabel['kind']) ? (raw.kind as PressLabel['kind']) : 'answer',
    answer: typeof raw.answer === 'string' ? raw.answer : '',
    text: raw.text,
    at: Number(raw.at) || 0,
  }
  if (typeof raw.from === 'number') label.from = raw.from
  if (typeof raw.turnId === 'string') label.turnId = raw.turnId
  return [label]
}

function upgradeSession(raw: unknown, now: number): SessionState {
  if (!isObject(raw)) return emptySession(now)
  const presses: Record<string, PressLabel> = {}
  for (const [id, l] of Object.entries(isObject(raw.presses) ? raw.presses : {})) for (const label of upgradeLabel(l)) presses[id] = label
  return {
    offset: typeof raw.offset === 'number' ? raw.offset : 0,
    queue: Array.isArray(raw.queue) ? raw.queue.flatMap(upgradeTurn) : [],
    ledger: isObject(raw.ledger) && Array.isArray(raw.ledger.items) ? upgradeLedger(raw.ledger as Ledger) : EMPTY,
    lastTurnId: typeof raw.lastTurnId === 'string' ? raw.lastTurnId : null,
    unread: Number(raw.unread) || 0,
    presses,
    touchedAt: typeof raw.touchedAt === 'number' ? raw.touchedAt : now,
    activeTurn: Number(raw.activeTurn) || 0,
    told: upgradeTold(raw.told),
    // A session saved before launches kept this shows no note.
    tools: raw.tools !== false,
    // A session saved before these were kept finds its transcript again by its id.
    transcript: typeof raw.transcript === 'string' ? raw.transcript : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
  }
}

/** A session saved before the agent read inbox text was told nothing. */
function upgradeTold(raw: unknown): Told {
  if (!isObject(raw)) return { inbox: null, closed: [] }
  return {
    inbox: typeof raw.inbox === 'string' ? raw.inbox : null,
    closed: Array.isArray(raw.closed) ? raw.closed.filter((id): id is string => typeof id === 'string') : [],
  }
}

/**
 * Reads any saved value into the current state shape. A missing or unreadable value is the empty state.
 * `now` is the touch time for a session saved before sessions kept one.
 */
export function upgradeState(raw: unknown, now = 0): State {
  if (!isObject(raw)) return emptyState()
  const terminals: State['terminals'] = {}
  for (const [id, t] of Object.entries(isObject(raw.terminals) ? raw.terminals : {})) {
    // A terminal saved with a workspaceId drops it: the launch's workspace id never matched `workspace.list`.
    if (isObject(t) && typeof t.sessionId === 'string') terminals[id] = { sessionId: t.sessionId }
  }
  const sessions: State['sessions'] = {}
  for (const [id, s] of Object.entries(isObject(raw.sessions) ? raw.sessions : {})) sessions[id] = upgradeSession(s, now)
  return { version: 1, terminals, sessions }
}
