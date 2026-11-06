// The turn tracker: reads each finished turn from a session's transcript, saves it, runs the inbox
// model on it and applies the answer (spec steps 2 and 4, plan T4).
//
// A turn is durable from the moment it is read (audit fix 1):
//   1. A complete turn is added to the session's queue and saved before the model runs. The offset stays.
//   2. One loop per session runs the model on the first turn in the queue. Another `done` only adds turns.
//   3. One write saves the new ledger, the turn's nextOffset, lastTurnId and the shorter queue.
//   4. A turn whose id is lastTurnId is never applied again.
//   5. At start, every turn still in a queue runs.
//   6. A failed model run keeps the turn for the next `done` or start. After 3 failures the turn is dropped
//      and counted in `unread`.
// The whole state is one storage value, so step 3 is one write and a crash leaves it all or nothing.
import { EMPTY, applyExchangeUpdate, closeItem } from './core/ledger'
import { ORCA, buildPrompt, screenText } from './core/model-text'
import { nowRows } from './core/now'
import type { Exchange, Ledger, Press } from './core/types'
import type { ModelResult } from './model'
import { STATE_KEY, emptySession, emptyState, upgradeState, type PressLabel, type SessionState, type State, type Turn } from './state'
import { readTurn, type TurnRead } from './transcript'

/** The part of `orca.storage` the tracker uses. */
export type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export type Clock = {
  now(): number
  sleep(ms: number): Promise<void>
}

export type TrackerDeps = {
  storage: Storage
  clock: Clock
  /** The session's whole transcript, or null when the file does not exist yet. */
  read(sessionId: string): Promise<Buffer | null>
  /** Runs the inbox model. `source` is what parseReply checks HELP values against. */
  model(prompt: string, source: string): Promise<ModelResult>
  log?(message: string): void
  /** Called after each saved change, so the worker can tell the panel. */
  changed?(): void
}

/** Read once a second, for up to 15 s after a `done`. A complete turn waits for 2 s with no growth. */
export const POLL_MS = 1000
export const LIMIT_MS = 15_000
export const QUIET_MS = 2000
export const MAX_FAILURES = 3
/** A session with no open rows and nothing queued is dropped after 7 days untouched. */
export const PRUNE_MS = 7 * 24 * 60 * 60 * 1000

/** The `<screen>` text for a turn: the panel lists the open rows, or shows none. */
export function screenFor(ledger: Ledger): string {
  const { questions, tasks } = nowRows(ledger)
  return screenText(ORCA, questions.length + tasks.length > 0, null)
}

/** The text parseReply checks HELP values against: the reply, then the activity. */
function sourceOf(ex: Exchange): string {
  return [ex.reply, ...ex.activity].join('\n')
}

/**
 * The ledger as the mod has it when the turn's prompt is built: its prompt count includes this turn. `ledger.turn` is
 * the transcript's count. The active turn that stamps tool calls is apart, in SessionState.activeTurn, so a model
 * run for turn N applies as N and never moves it.
 */
function atTurn(ledger: Ledger, turn: number): Ledger {
  return turn > ledger.turn ? { ...ledger, turn } : ledger
}

/** The labels of rows and findings still open: a closed row's label goes with it. */
function openLabels(ledger: Ledger, presses: Record<string, PressLabel>): Record<string, PressLabel> {
  return Object.fromEntries(
    Object.entries(presses).filter(([id]) => ledger.items.some(i => i.id === id) || ledger.findings.some(f => f.id === id)),
  )
}

/**
 * The press a turn answers: the option whose prompt has the turn's id. Typed words, a step or a finding's press is
 * no answer: its row stays open, and the model reads the turn and decides, as the inbox's does.
 */
function pressFor(s: SessionState, turnId: string): { press: Press; answer: string } | null {
  const hit = Object.entries(s.presses).find(([, l]) => l.turnId === turnId && l.kind === 'answer')
  return hit ? { press: { id: hit[0], action: 'answer' }, answer: hit[1].answer } : null
}

/** Where the next turn starts: after the last queued turn, else at the saved offset. */
function readFrom(s: SessionState): number {
  return s.queue.at(-1)?.nextOffset ?? s.offset
}

/** The person's prompts before readFrom, when known without reading the file from the start. */
function promptsBefore(s: SessionState): number | undefined {
  const last = s.queue.at(-1)
  if (last) return last.exchange.turn
  if (s.offset === 0) return 0
  return s.lastTurnId ? s.ledger.turn : undefined
}

export function createTracker(deps: TrackerDeps) {
  const { storage, clock } = deps
  let state: State = emptyState()
  let writes: Promise<void> = Promise.resolve()
  /** Each session's poll deadline, while a poll runs. */
  const deadlines = new Map<string, number>()
  /** Sessions whose model loop runs. */
  const running = new Set<string>()

  /** Saves a copy of the whole state. Writes land in the order they were made. */
  function save(): Promise<void> {
    const copy = JSON.parse(JSON.stringify(state)) as State
    writes = writes.catch(() => undefined).then(() => storage.set(STATE_KEY, copy))
    void writes.then(() => deps.changed?.(), () => undefined)
    return writes
  }

  function update(sessionId: string, change: (s: SessionState) => SessionState): void {
    state = { ...state, sessions: { ...state.sessions, [sessionId]: change(state.sessions[sessionId]) } }
  }

  function background(work: Promise<void>): void {
    work.catch(e => deps.log?.(`turns: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Removes the queue's first turn and moves the offset past it, with the ledger it leaves. */
  function settle(s: SessionState, turn: Turn, ledger: Ledger, unread: number): SessionState {
    return {
      ...s,
      ledger: atTurn(ledger, turn.exchange.turn),
      presses: openLabels(ledger, s.presses),
      offset: turn.nextOffset,
      lastTurnId: turn.turnId,
      queue: s.queue.slice(1),
      unread: s.unread + unread,
    }
  }

  /** Runs the model on each queued turn in order. A turn that failed before runs only on a retry: a `done` or start. */
  async function drain(sessionId: string, retry: boolean): Promise<void> {
    if (running.has(sessionId)) return
    running.add(sessionId)
    try {
      for (;;) {
        const s = state.sessions[sessionId]
        const turn = s?.queue[0]
        if (!turn || (turn.failures > 0 && !retry)) return
        if (turn.turnId === s.lastTurnId) {
          update(sessionId, cur => settle(cur, turn, cur.ledger, 0))
          await save()
          continue
        }
        // The turn that answers a press: the row closes as answered before the model reads the ledger, as the mod
        // closes it at the press. The commit write saves the close.
        const answered = pressFor(s, turn.turnId)
        const exchange: Exchange = { ...turn.exchange, press: answered?.press ?? turn.exchange.press }
        if (answered && s.ledger.items.some(i => i.id === answered.press.id)) {
          update(sessionId, cur => ({ ...cur, ledger: closeItem(cur.ledger, answered.press.id, { how: 'answered', outcome: answered.answer }, clock.now()) }))
        }
        const ledgerNow = state.sessions[sessionId].ledger
        const promptAt = clock.now()
        const result = await deps.model(buildPrompt(atTurn(ledgerNow, exchange.turn), exchange), sourceOf(exchange))
        if (result.ok) {
          // Apply to the ledger as it is now: a press may have closed a row while the model ran.
          update(sessionId, cur =>
            settle(cur, turn, applyExchangeUpdate(atTurn(cur.ledger, exchange.turn), result.update, exchange, clock.now(), promptAt), 0),
          )
          await save()
          continue
        }
        deps.log?.(`turns: model ${result.reason} for ${turn.turnId}: ${result.detail}`)
        const failures = turn.failures + 1
        if (failures >= MAX_FAILURES) {
          update(sessionId, cur => settle(cur, turn, cur.ledger, 1))
          await save()
          continue
        }
        update(sessionId, cur => ({ ...cur, queue: [{ ...turn, failures }, ...cur.queue.slice(1)] }))
        await save()
        return // retried at the next `done` or start
      }
    } finally {
      running.delete(sessionId)
    }
  }

  /** Saves a read turn to the queue, then starts the model loop. False when the turn is already known. */
  async function enqueue(sessionId: string, read: TurnRead): Promise<boolean> {
    const s = state.sessions[sessionId]
    if (read.turnId === s.lastTurnId || s.queue.some(t => t.turnId === read.turnId)) return false
    const turn: Turn = {
      turnId: read.turnId,
      exchange: { ...read.exchange, screen: screenFor(s.ledger) },
      nextOffset: read.nextOffset,
      failures: 0,
    }
    update(sessionId, cur => ({ ...cur, queue: [...cur.queue, turn] }))
    await save()
    background(drain(sessionId, false))
    return true
  }

  /** Reads the transcript once a second until the deadline, and queues each turn that is done. */
  async function poll(sessionId: string): Promise<void> {
    const deadline = clock.now() + LIMIT_MS
    if (deadlines.has(sessionId)) {
      deadlines.set(sessionId, Math.max(deadline, deadlines.get(sessionId) as number))
      return
    }
    deadlines.set(sessionId, deadline)
    let size = -1
    let grewAt = clock.now()
    try {
      for (;;) {
        const s = state.sessions[sessionId]
        if (!s) return
        const bytes = await deps.read(sessionId)
        if (bytes && bytes.length !== size) {
          size = bytes.length
          grewAt = clock.now()
        }
        const read = bytes ? readTurn(bytes, readFrom(s), promptsBefore(s)) : null
        // An incomplete turn is final: a later prompt follows it. A complete one may still grow.
        const isDone = read?.status === 'incomplete' || (read?.status === 'complete' && clock.now() - grewAt >= QUIET_MS)
        if (read && isDone && (await enqueue(sessionId, read))) continue
        if (clock.now() >= (deadlines.get(sessionId) as number)) return
        await clock.sleep(POLL_MS)
      }
    } finally {
      deadlines.delete(sessionId)
    }
  }

  return {
    /** Loads the saved state, runs every queued turn and reads each tracked session again. */
    async start(): Promise<void> {
      state = upgradeState(await storage.get(STATE_KEY), clock.now())
      for (const [id, s] of Object.entries(state.sessions)) if (s.queue.length > 0) background(drain(id, true))
      for (const { sessionId } of Object.values(state.terminals)) background(poll(sessionId))
    },

    /**
     * Maps a terminal to the session its launch was tagged with. A session new to the state starts reading at
     * `offset`: a resumed session's transcript end, so its old turns are never read again. Its ledger's turn starts at
     * `turn`: the person's prompts before `offset`, so the turn a prompt-start raises matches the turn the transcript
     * gives. A known session keeps its own offset and turn.
     * Another terminal mapped to the same session stops being tracked. A null terminal saves the session with no
     * terminal: a launch Orca gave no terminal id, bound later by `bind`.
     */
    async track(
      terminalId: string | null,
      sessionId: string,
      opts: { offset?: number; turn?: number; tools?: boolean } = {},
    ): Promise<void> {
      const terminals = terminalId === null ? state.terminals : Object.fromEntries(Object.entries(state.terminals).filter(([, t]) => t.sessionId !== sessionId))
      const known = state.sessions[sessionId]
      state = {
        ...state,
        terminals: terminalId === null ? terminals : { ...terminals, [terminalId]: { sessionId } },
        sessions: {
          ...state.sessions,
          [sessionId]: known
            ? { ...known, touchedAt: clock.now(), tools: opts.tools ?? known.tools }
            : { ...emptySession(clock.now()), offset: opts.offset ?? 0, ledger: { ...EMPTY, turn: opts.turn ?? 0 }, tools: opts.tools ?? true },
        },
      }
      await save()
    },

    /**
     * Maps a terminal to a known session that has no terminal yet: the prompt hook's terminal, for a launch Orca gave
     * no terminal id. False when nothing changed.
     */
    async bind(terminalId: string, sessionId: string): Promise<boolean> {
      if (!state.sessions[sessionId] || Object.values(state.terminals).some(t => t.sessionId === sessionId)) return false
      state = { ...state, terminals: { ...state.terminals, [terminalId]: { sessionId } } }
      await save()
      return true
    },

    /** Changes a session and saves it. The change lands in this tick, before the write: a press checks and sends in one tick. */
    edit(sessionId: string, change: (s: SessionState) => SessionState): Promise<void> {
      if (!state.sessions[sessionId]) return Promise.resolve()
      update(sessionId, cur => ({ ...change(cur), touchedAt: clock.now() }))
      return save()
    },

    /** Drops a session with no open rows and nothing queued that nobody touched for PRUNE_MS, and its terminals. */
    async prune(): Promise<void> {
      const now = clock.now()
      const sessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([, s]) => s.ledger.items.length > 0 || s.queue.length > 0 || now - s.touchedAt < PRUNE_MS),
      )
      const terminals = Object.fromEntries(Object.entries(state.terminals).filter(([, t]) => sessions[t.sessionId]))
      const same = Object.keys(sessions).length === Object.keys(state.sessions).length && Object.keys(terminals).length === Object.keys(state.terminals).length
      if (same) return
      state = { ...state, terminals, sessions }
      await save()
    },

    /** A `done` for a terminal: retry a failed turn, then read the transcript for new turns. */
    async done(terminalId: string): Promise<void> {
      const sessionId = state.terminals[terminalId]?.sessionId
      if (!sessionId || !state.sessions[sessionId]) return
      update(sessionId, s => ({ ...s, touchedAt: clock.now() }))
      background(drain(sessionId, true))
      await poll(sessionId)
    },

    state(): State {
      return state
    },
  }
}

export type Tracker = ReturnType<typeof createTracker>
