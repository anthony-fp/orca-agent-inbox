// Presses on a row (spec step 6, plan T7). Answer types the answer into the agent's terminal, only when the
// agent waits at its prompt. Done and Dismiss close the row in the plugin's own state; nothing goes to the agent.
//
// The send check (audit fix 2): each press carries the terminal, session and `drawn` token the row was drawn with.
// In the same tick as the send, the worker checks that the terminal still maps to that session, that the newest
// status says the main agent is `done`, and that the session's lastTurnId and queue still match `drawn`. A failed
// check holds the answer ("Waits for the agent"). A send whose result is not certain reads "Not delivered". The
// plugin never sends a held or undelivered answer again by itself.
import { closeItem } from './core/ledger'
import { nowRows, type NowRow } from './core/now'
import type { Item } from './core/types'
import type { PressLabel, SessionState, State } from './state'
import { promptAfter } from './transcript'
import type { Clock } from './turns'

/** How long a send waits for its prompt to show in the transcript. */
export const CONFIRM_MS = 10_000
export const CONFIRM_POLL_MS = 1000

/** The newest status Orca reported for a terminal's main agent. */
export type TerminalStatus = 'working' | 'blocked' | 'waiting' | 'done'

/** What the panel shows on a row after a press. `copy` is the text a Copy button copies. */
export type RowLabel = { text: string; tone: 'muted' | 'success' | 'danger'; copy: string | null }

export type LabelledRow = NowRow & { label: RowLabel | null }

export type PressInput = {
  terminalId: string
  sessionId: string
  /** The session's `drawnToken` when the row was drawn. */
  drawn: string
  /** The item id of the row. */
  id: string
  action: 'answer' | 'done' | 'dismiss'
  /** The option or typed words, for `answer`. */
  answer?: string
}

export type PressOutcome =
  | { ok: true; label: RowLabel | null }
  /** closed: the row closed since it was drawn. invalid: no session, or an answer with no words. */
  | { ok: false; refused: 'closed' | 'invalid' }

export type PressDeps = {
  state(): State
  edit(sessionId: string, change: (s: SessionState) => SessionState): Promise<void>
  status(terminalId: string): TerminalStatus | undefined
  /** Types the text and presses Enter. True when Orca accepted it. */
  send(terminalId: string, text: string): Promise<boolean>
  read(sessionId: string): Promise<Buffer | null>
  clock: Clock
  log?(message: string): void
}

/** What a row is drawn with, beside its terminal and session: the press is stale when this changes. */
export function drawnToken(s: SessionState): string {
  return JSON.stringify([s.lastTurnId, s.queue.map(t => t.turnId)])
}

/** The inbox mod's answer message (`messages.answer` in the inbox repo's `hooks/presses.ts`), on one line: a newline would submit early. */
export function answerText(item: Item, answer: string): string {
  return `Re "${item.ask}": ${answer}`.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

export function rowLabel(label: PressLabel): RowLabel {
  switch (label.state) {
    case 'sending':
      return { text: 'Sending…', tone: 'muted', copy: null }
    case 'answered':
      return { text: '✓ Answered', tone: 'success', copy: null }
    case 'held':
      return { text: 'Waits for the agent', tone: 'muted', copy: label.text }
    case 'undelivered':
      return { text: 'Not delivered', tone: 'danger', copy: label.text }
  }
}

/** The session's open rows, from nowRows, each with its press label. */
export function labelledRows(s: SessionState): { questions: LabelledRow[]; tasks: LabelledRow[] } {
  const { questions, tasks } = nowRows(s.ledger)
  const add = (r: NowRow): LabelledRow => ({ ...r, label: s.presses[r.id] ? rowLabel(s.presses[r.id]) : null })
  return { questions: questions.map(add), tasks: tasks.map(add) }
}

/** The send check, in one tick. Null when the send may go, else why it holds. */
export function sendCheck(state: State, status: TerminalStatus | undefined, p: PressInput): string | null {
  if (state.terminals[p.terminalId]?.sessionId !== p.sessionId) return 'the terminal has another session'
  if (status !== 'done') return `the agent is ${status ?? 'not known'}`
  const s = state.sessions[p.sessionId]
  if (!s || drawnToken(s) !== p.drawn) return 'a turn ended since the row was drawn'
  return null
}

function setLabel(s: SessionState, id: string, label: PressLabel): SessionState {
  return { ...s, presses: { ...s.presses, [id]: label } }
}

export function createPresses(deps: PressDeps) {
  const { clock } = deps

  /** Sets a press's label, only while the row is open and still shows that press. */
  function settle(sessionId: string, id: string, at: number, change: Partial<PressLabel>): Promise<void> {
    return deps.edit(sessionId, s => {
      const cur = s.presses[id]
      return cur && cur.at === at && s.ledger.items.some(i => i.id === id) ? setLabel(s, id, { ...cur, ...change }) : s
    })
  }

  /** Reads the transcript once a second for up to CONFIRM_MS, for the prompt the send typed. */
  async function confirm(sessionId: string, id: string, label: PressLabel): Promise<void> {
    const deadline = clock.now() + CONFIRM_MS
    for (;;) {
      const bytes = await deps.read(sessionId)
      const prompt = bytes ? promptAfter(bytes, label.from ?? 0) : null
      if (prompt) {
        // Another prompt first means this answer's fate is not known.
        const ours = prompt.text.replace(/\s+/g, ' ').includes(label.text)
        return settle(sessionId, id, label.at, ours ? { state: 'answered', turnId: prompt.uuid } : { state: 'undelivered' })
      }
      if (clock.now() >= deadline) return settle(sessionId, id, label.at, { state: 'undelivered' })
      await clock.sleep(CONFIRM_POLL_MS)
    }
  }

  return {
    async press(p: PressInput): Promise<PressOutcome> {
      const before = deps.state().sessions[p.sessionId]
      if (!before) return { ok: false, refused: 'invalid' }
      if (!before.ledger.items.some(i => i.id === p.id)) return { ok: false, refused: 'closed' }

      if (p.action === 'done' || p.action === 'dismiss') {
        const how = p.action === 'done' ? 'done' : 'dismissed'
        await deps.edit(p.sessionId, s => ({ ...s, ledger: closeItem(s.ledger, p.id, { how, outcome: how }, clock.now()) }))
        return { ok: true, label: null }
      }

      const words = p.answer?.trim() ?? ''
      if (!words) return { ok: false, refused: 'invalid' }
      // Where the answer's prompt will start. Read before the check, so nothing waits between the check and the send.
      const bytes = await deps.read(p.sessionId)

      // From here to the send: one tick.
      const state = deps.state()
      const s = state.sessions[p.sessionId]
      const item = s?.ledger.items.find(i => i.id === p.id)
      if (!s || !item) return { ok: false, refused: 'closed' }
      const label: PressLabel = { state: 'sending', answer: words, text: answerText(item, words), at: clock.now() }
      const status = deps.status(p.terminalId)
      const why = sendCheck(state, status, p)
      if (why) {
        deps.log?.(`press: held for ${p.id}: ${why}`)
        const held = { ...label, state: 'held' as const }
        await deps.edit(p.sessionId, cur => setLabel(cur, p.id, held))
        return { ok: true, label: rowLabel(held) }
      }
      label.from = bytes?.length ?? 0
      const saving = deps.edit(p.sessionId, cur => setLabel(cur, p.id, label))
      const sending = deps.send(p.terminalId, label.text).catch(e => {
        deps.log?.(`press: send failed for ${p.id}: ${e instanceof Error ? e.message : String(e)}`)
        return false
      })

      await saving
      const accepted = await sending
      if (!accepted) {
        await settle(p.sessionId, p.id, label.at, { state: 'undelivered' })
        return { ok: true, label: rowLabel({ ...label, state: 'undelivered' }) }
      }
      // Orca's answer does not say the agent took the text: a status change during the send is the agent starting,
      // or something else. Only the answer's own prompt in the transcript confirms it; anything else reads "Not delivered".
      void confirm(p.sessionId, p.id, label).catch(e => deps.log?.(`press: ${e instanceof Error ? e.message : String(e)}`))
      return { ok: true, label: rowLabel(label) }
    },
  }
}

export type Presses = ReturnType<typeof createPresses>
