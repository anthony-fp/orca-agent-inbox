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
import { EMPTY, applyExchangeUpdate, closeItem, keepIds, pruneClosed } from './core/ledger'
import { type CodexTurnRead } from './core/codex-transcript'
import { ORCA, buildPrompt, screenText } from './core/model-text'
import { nowRows } from './core/now'
import type { Exchange, Ledger, Press } from './core/types'
import type { ModelResult } from './model'
import { STATE_KEY, emptySession, emptyState, newerVersion, upgradeState, type CurrentState, type PressLabel, type SessionState, type Turn } from './state'
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
  model(prompt: string, source: string, codexHome?: string): Promise<ModelResult>
  /** Reads one Codex rollout turn; Claude keeps using readTurn on the transcript bytes. */
  codexTurn?(sessionId: string, offset: number): Promise<CodexTurnRead | null>
  log?(message: string): void
  /** Called after each saved change, so the worker can tell the panel. */
  changed?(): void
  /** The handles of live terminals in every workspace, or null when unknown. Null evicts nothing. */
  live?(): ReadonlySet<string> | null
}

/** Read once a second, for up to 15 s after a `done`. A complete turn waits for 2 s with no growth. */
export const POLL_MS = 1000
export const LIMIT_MS = 15_000
export const QUIET_MS = 2000
export const MAX_FAILURES = 3
/** A session with no open rows and nothing queued is dropped after 7 days untouched. */
export const PRUNE_MS = 7 * 24 * 60 * 60 * 1000
/** A session touched in the last 24 h is kept: a terminal opened since the last terminal list is not in it yet. */
export const KEEP_MS = 24 * 60 * 60 * 1000
/** Save drops evictable sessions, oldest first, while the state is over this size. Orca rejects a value over 262144 bytes. */
export const BUDGET = 200_000

const byteSize = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

/**
 * The sessions that can go, oldest `touchedAt` first; none when `live` is null. A session is kept when it has an open
 * item or finding or a queued turn, was touched in the last `keepMs`, is bound to a live terminal (directly or through
 * its pane), is `busy` (a poll or drain runs), or is linked through `moved`, either way and transitively, to a kept one.
 */
export function evictable(state: CurrentState, live: ReadonlySet<string> | null, now: number, keepMs = KEEP_MS, busy: ReadonlySet<string> = new Set()): string[] {
  if (!live) return []
  const kept = new Set<string>()
  for (const [id, s] of Object.entries(state.sessions))
    if (s.ledger.items.length > 0 || s.ledger.findings.length > 0 || s.queue.length > 0 || now - s.touchedAt < keepMs || busy.has(id)) kept.add(id)
  for (const [handle, t] of Object.entries(state.terminals)) {
    if (!live.has(handle)) continue
    kept.add(t.sessionId)
    const pane = t.paneKey ? state.panes[t.paneKey] : undefined
    if (pane) kept.add(pane.threadId)
  }
  for (let grew = true; grew;) {
    grew = false
    for (const [id, target] of Object.entries(state.moved ?? {}))
      if (kept.has(id) !== kept.has(target)) { kept.add(id); kept.add(target); grew = true }
  }
  return Object.entries(state.sessions).filter(([id]) => !kept.has(id)).sort(([, a], [, b]) => a.touchedAt - b.touchedAt).map(([id]) => id)
}

/** The state without `drop`, and without the terminals, panes and aliases of a session that is not left. */
function without(state: CurrentState, drop: ReadonlySet<string>): CurrentState {
  const sessions = Object.fromEntries(Object.entries(state.sessions).filter(([id]) => !drop.has(id)))
  return {
    ...state,
    sessions,
    terminals: Object.fromEntries(Object.entries(state.terminals).filter(([, t]) => sessions[t.sessionId])),
    panes: Object.fromEntries(Object.entries(state.panes).filter(([, p]) => sessions[p.threadId])),
    moved: Object.fromEntries(Object.entries(state.moved ?? {}).filter(([id, target]) => sessions[id] && sessions[target])),
  }
}

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
 * The press a turn answers: the option or Explain whose prompt has the turn's id. An option closes its row. An
 * Explain keeps its row open on that turn: the ledger drops the model's close of it. Typed words, a step or a
 * finding's Fix or File issue is no press here: its row stays open, and the model reads the turn and decides, as the
 * inbox's does.
 */
function pressFor(s: SessionState, turnId: string): { press: Press; answer: string } | null {
  const hit = Object.entries(s.presses).find(([, l]) => l.turnId === turnId && (l.kind === 'answer' || l.kind === 'explain'))
  return hit ? { press: { id: hit[0], action: hit[1].kind === 'explain' ? 'explain' : 'answer' }, answer: hit[1].answer } : null
}

/** Cuts the session's closed records, and the told ids of records cut. */
function pruned(s: SessionState): SessionState {
  const ledger = pruneClosed(s.ledger, keepIds(s.ledger, s.presses))
  const kept = new Set(ledger.closed.map(c => c.id))
  return { ...s, ledger, told: { ...s.told, closed: s.told.closed.filter(id => kept.has(id)) } }
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
  let state: CurrentState = emptyState()
  let writes: Promise<void> = Promise.resolve()
  /** True when the stored state is a newer version: save writes nothing, so this plugin never overwrites it. */
  let readOnly = false
  /** Each session's poll deadline, while a poll runs. */
  const deadlines = new Map<string, number>()
  /** Sessions whose model loop runs. */
  const running = new Set<string>()

  const isCodex = (sessionId: string) => state.sessions[sessionId]?.agent === 'codex'
  const busy = () => new Set([...deadlines.keys(), ...running])

  /** Saves a copy of the whole state. Writes land in the order they were made. */
  function save(): Promise<void> {
    if (readOnly) return Promise.resolve()
    state = { ...state, sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, s]) => [id, pruned(s)])) }
    // Best effort: when only kept sessions are left, the save still runs.
    let size = byteSize(state)
    const drop = new Set<string>()
    for (const id of size > BUDGET ? evictable(state, deps.live?.() ?? null, clock.now(), KEEP_MS, busy()) : []) {
      if (size <= BUDGET) break
      drop.add(id)
      size -= byteSize({ [id]: state.sessions[id] }) - 1
    }
    if (drop.size > 0) state = without(state, drop)
    const copy = JSON.parse(JSON.stringify(state)) as CurrentState
    writes = writes.catch(() => undefined).then(() => storage.set(STATE_KEY, copy))
    // The panel reloads after a failed write too: the state in memory moved on, and a stuck label must not stay.
    void writes.then(() => deps.changed?.(), e => {
      deps.log?.(`turns: save failed: ${e instanceof Error ? e.message : String(e)}`)
      deps.changed?.()
    })
    return writes
  }

  function update(sessionId: string, change: (s: SessionState) => SessionState): void {
    state = { ...state, sessions: { ...state.sessions, [sessionId]: change(state.sessions[sessionId]) } }
  }

  function background(work: Promise<void>): void {
    work.catch(e => deps.log?.(`turns: ${e instanceof Error ? e.message : String(e)}`))
  }

  /**
   * Removes the queue's first turn and moves the offset past it, with the ledger it leaves. A press that got this turn's
   * id while the model ran (confirm() saw its prompt late) closes its row as answered here, as drain does at the start.
   */
  function settle(s: SessionState, turn: Turn, given: Ledger, unread: number): SessionState {
    const answered = pressFor(s, turn.turnId)
    const ledger = answered?.press.action === 'answer' && given.items.some(i => i.id === answered.press.id)
      ? closeItem(given, answered.press.id, { how: 'answered', outcome: answered.answer }, clock.now())
      : given
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
        if (answered?.press.action === 'answer' && s.ledger.items.some(i => i.id === answered.press.id)) {
          update(sessionId, cur => ({ ...cur, ledger: closeItem(cur.ledger, answered.press.id, { how: 'answered', outcome: answered.answer }, clock.now()) }))
        }
        const ledgerNow = state.sessions[sessionId].ledger
        const promptAt = clock.now()
        const result = await deps.model(buildPrompt(atTurn(ledgerNow, exchange.turn), exchange), sourceOf(exchange), s.agent === 'codex' ? s.codexHome ?? '' : undefined)
        if (result.ok) {
          // Apply to the ledger as it is now: a press may have closed a row while the model ran.
          update(sessionId, cur =>
            settle(cur, turn, applyExchangeUpdate(atTurn(cur.ledger, exchange.turn), result.update, exchange, clock.now(), promptAt), 0),
          )
          await save()
          continue
        }
        deps.log?.(`turns: model ${result.reason} for ${turn.turnId}: ${result.detail}`)
        if ((result.reason === 'timeout' || result.reason === 'unavailable') && s.agent === 'codex') return
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
        const read = bytes
          ? s.agent === 'codex' ? await deps.codexTurn?.(sessionId, readFrom(s)) ?? null : readTurn(bytes, readFrom(s), promptsBefore(s))
          : null
        // An incomplete turn is final: a later prompt follows it. A complete one may still grow.
        const isDone = read?.status === 'incomplete' || (read?.status === 'complete' && (s.agent === 'codex' || clock.now() - grewAt >= QUIET_MS))
        if (read && isDone && (await enqueue(sessionId, read))) continue
        if (clock.now() >= (deadlines.get(sessionId) as number)) return
        await clock.sleep(POLL_MS)
      }
    } finally {
      deadlines.delete(sessionId)
    }
  }

  function codexStatus(sessionId: string, done: boolean): void {
    if (done) retryCodex(sessionId)
  }

  function retryCodex(sessionId: string): void {
    const s = state.sessions[sessionId]
    if (s?.agent !== 'codex') return
    if (s.queue.length > 0) background(drain(sessionId, true))
    background(poll(sessionId))
  }

  /** Drops the evictable sessions untouched for PRUNE_MS, and the terminals, panes and aliases of a session that is gone. */
  async function prune(): Promise<void> {
    const next = without(state, new Set(evictable(state, deps.live?.() ?? null, clock.now(), PRUNE_MS, busy())))
    const count = (s: CurrentState) => [s.sessions, s.terminals, s.panes].map(o => Object.keys(o).length).join()
    if (count(next) === count(state)) return
    state = next
    await save()
  }

  return {
    /** A launch discards the old Codex binding but keeps the pane's launch time. */
    async clearPane(terminalId: string, launchedAt = clock.now(), paneKey?: string): Promise<void> {
      const key = state.terminals[terminalId]?.paneKey ?? paneKey
      // Every new launch ends the terminal's old binding, so no press reaches the new process through it.
      if (!key) {
        if (!state.terminals[terminalId]) return
        state = { ...state, terminals: Object.fromEntries(Object.entries(state.terminals).filter(([id]) => id !== terminalId)) }
        return save()
      }
      state = {
        ...state,
        terminals: Object.fromEntries(Object.entries(state.terminals).filter(([id]) => id !== terminalId)),
        panes: Object.fromEntries(Object.entries(state.panes).filter(([id]) => id !== key)),
        paneLaunches: { ...state.paneLaunches, [key]: launchedAt },
        pendingCodex: state.pendingCodex && Object.fromEntries(Object.entries(state.pendingCodex).filter(([id]) => id !== key)),
      }
      await save()
    },

    async markPaneLaunch(paneKey: string, launchedAt: number): Promise<void> {
      if ((state.paneLaunches[paneKey] ?? -Infinity) >= launchedAt) return
      state = { ...state, paneLaunches: { ...state.paneLaunches, [paneKey]: launchedAt } }
      await save()
    },

    /**
     * Loads the saved state, waits for `listed` (the first terminal list), prunes, then runs every queued turn and reads
     * each tracked session again. The prune runs before the polls, so a poll does not keep a dead session.
     */
    async start(listed?: () => Promise<void>): Promise<void> {
      const raw = await storage.get(STATE_KEY)
      const newer = newerVersion(raw)
      if (newer !== null) {
        readOnly = true
        deps.log?.(`turns: stored state version ${newer} is newer than this plugin`)
      }
      state = upgradeState(raw, clock.now())
      await listed?.()
      await prune()
      for (const [id, s] of Object.entries(state.sessions)) if (s.queue.length > 0) background(drain(id, true))
      for (const { sessionId } of Object.values(state.terminals)) if (!isCodex(sessionId)) background(poll(sessionId))
      for (const [sessionId, s] of Object.entries(state.sessions))
        if (s.agent === 'codex' && s.transcript) background(poll(sessionId))
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
      opts: { offset?: number; turn?: number; tools?: boolean; pane?: { key: string; codexHome: string; promptHookSeen: boolean } } = {},
    ): Promise<void> {
      const terminals = terminalId === null ? state.terminals : Object.fromEntries(Object.entries(state.terminals).filter(([, t]) => t.sessionId !== sessionId))
      const known = state.sessions[sessionId]
      state = {
        ...state,
        terminals: terminalId === null ? terminals : { ...terminals, [terminalId]: { sessionId, ...(opts.pane ? { paneKey: opts.pane.key } : {}) } },
        panes: opts.pane ? {
          ...state.panes,
          [opts.pane.key]: {
            agent: 'codex', threadId: sessionId, codexHome: opts.pane.codexHome,
            promptHookSeen: opts.pane.promptHookSeen || (state.panes[opts.pane.key]?.threadId === sessionId && state.panes[opts.pane.key]?.promptHookSeen === true),
          },
        } : state.panes,
        sessions: {
          ...state.sessions,
          [sessionId]: known
            ? { ...known, touchedAt: clock.now(), tools: opts.tools ?? known.tools,
                ...(opts.pane ? { agent: 'codex' as const, codexHome: opts.pane.codexHome || known.codexHome } : {}) }
            : { ...emptySession(clock.now()), offset: opts.offset ?? 0, ledger: { ...EMPTY, turn: opts.turn ?? 0 }, tools: opts.tools ?? true,
                ...(opts.pane ? { agent: 'codex' as const, codexHome: opts.pane.codexHome || null } : {}) },
        },
      }
      await save()
    },

    /**
     * Maps a terminal to a known session that has no terminal yet: the prompt hook's terminal, for a launch Orca gave
     * no terminal id. False when nothing changed.
     */
    async bind(terminalId: string, sessionId: string, paneKey?: string): Promise<boolean> {
      if (!state.sessions[sessionId] || (paneKey && state.panes[paneKey]?.threadId !== sessionId) || (!paneKey && Object.values(state.terminals).some(t => t.sessionId === sessionId))) return false
      const terminals = paneKey ? Object.fromEntries(Object.entries(state.terminals).filter(([, t]) => t.sessionId !== sessionId)) : state.terminals
      state = { ...state, terminals: { ...terminals, [terminalId]: { sessionId, ...(paneKey ? { paneKey } : {}) } } }
      await save()
      return true
    },

    /** Keeps MCP calls tagged with Claude's launch id on the conversation now in that terminal. */
    async move(launchSession: string, sessionId: string): Promise<void> {
      const moved = { ...state.moved }
      if (launchSession === sessionId) delete moved[launchSession]
      else moved[launchSession] = sessionId
      state = { ...state, moved }
      await save()
    },

    /**
     * Changes a session and saves it. The change lands in this tick, before the write: a press checks and sends in one tick.
     * With `undoOnFail`, a rejected write undoes the change, for a caller that reports the failure; unless a later change,
     * whose own save carries this one, came in between.
     */
    edit(sessionId: string, change: (s: SessionState) => SessionState, opts: { undoOnFail?: boolean } = {}): Promise<void> {
      if (!state.sessions[sessionId]) return Promise.resolve()
      const before = state.sessions[sessionId]
      update(sessionId, cur => ({ ...change(cur), touchedAt: clock.now() }))
      const written = save()
      if (!opts.undoOnFail) return written
      const mine = state.sessions[sessionId]
      return written.catch(e => {
        if (mine && state.sessions[sessionId] === mine) update(sessionId, () => before)
        throw e
      })
    },

    prune,

    /** A `done` for a terminal: retry a failed turn, then read the transcript for new turns. */
    async done(terminalId: string): Promise<void> {
      const sessionId = state.terminals[terminalId]?.sessionId
      if (!sessionId || !state.sessions[sessionId]) return
      if (isCodex(sessionId)) return codexStatus(sessionId, true)
      update(sessionId, s => ({ ...s, touchedAt: clock.now() }))
      background(drain(sessionId, true))
      await poll(sessionId)
    },

    /** A Codex done status starts reading the rollout. */
    codexStatus,

    /** A Codex notify starts reading the rollout from its saved offset. */
    async codexNotify(sessionId: string, _turnId: string): Promise<void> { retryCodex(sessionId) },

    /** A later binding or status retries a rollout read. */
    retryCodex,

    /** Retains a notify-only thread until its rollout proves it is the pane's main chat. */
    async stageCodex(paneKey: string, threadId: string, codexHome: string, turnId: string): Promise<void> {
      if (!turnId) return
      const old = state.pendingCodex?.[paneKey] ?? []
      const found = old.find(entry => entry.threadId === threadId && entry.turnId === turnId)
      if (found) return
      const entries = [...old, { threadId, codexHome, turnId }]
      state = { ...state, pendingCodex: { ...state.pendingCodex, [paneKey]: entries } }
      await save()
    },

    async clearStagedCodex(paneKey: string, threadId: string, turnId: string): Promise<void> {
      const old = state.pendingCodex?.[paneKey] ?? []
      if (!old.some(entry => entry.threadId === threadId && entry.turnId === turnId)) return
      const pendingCodex = { ...state.pendingCodex }
      const left = old.filter(entry => entry.threadId !== threadId || entry.turnId !== turnId)
      if (left.length > 0) pendingCodex[paneKey] = left
      else delete pendingCodex[paneKey]
      state = { ...state, ...(Object.keys(pendingCodex).length > 0 ? { pendingCodex } : { pendingCodex: undefined }) }
      await save()
    },

    state(): CurrentState {
      return state
    },
  }
}

export type Tracker = ReturnType<typeof createTracker>
