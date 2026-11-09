// Presses on a row (spec step 6, plans T7 and T12). An option, a typed reply, a step that runs a command, and a
// finding's Fix or File issue each type the inbox's message into the agent's terminal; the panel does the other steps.
// Done and Dismiss close the row in the plugin's own state; nothing goes
// to the agent.
//
// The send check: each press carries its terminal and session.
// In the same tick as the send, the worker checks that the terminal still maps to that session and, for Codex, that
// the prompt hook was trusted. A failed check holds the answer. A send whose result is not certain reads "Not delivered".
import { closeFinding, closeItem } from './core/ledger'
import { findingRows, fixLabel, nowRows, stepsOf, type FindingGroups, type FindingRow, type NowGroups, type NowRow } from './core/now'
import type { Finding, Item, Ledger } from './core/types'
import type { PressLabel, SessionState, State } from './state'
import { codexPromptAfter } from './core/codex-transcript'
import { promptAfter } from './transcript'
import type { Clock } from './turns'

/** How long a send waits for its prompt after the agent is done. */
export const CONFIRM_MS = 10_000
export const CONFIRM_POLL_MS = 1000

/** The newest status Orca reported for a terminal's main agent. */
export type TerminalStatus = 'working' | 'blocked' | 'waiting' | 'done'

/** What the panel shows on a row after a press. `copy` is the text a Copy button copies. */
export type RowLabel = { text: string; tone: 'muted' | 'success' | 'danger'; copy: string | null }

/** `explained`: the row's last press was Explain, so its Explain button reads "Explain again". */
export type LabelledRow = NowRow & { label: RowLabel | null; explained: boolean }
export type LabelledFinding = FindingRow & { label: RowLabel | null; explained: boolean }
export type LabelledFindings = Omit<FindingGroups, 'issues' | 'opportunities'> & {
  issues: LabelledFinding[]
  opportunities: LabelledFinding[]
}

export type PressInput = {
  terminalId: string
  sessionId: string
  /** The session's `drawnToken` when the row was drawn. */
  drawn: string
  /** The item or finding id of the row. */
  id: string
  /**
   * `answer` sends a question's option, which closes the row when its turn runs. `reply` sends typed words on any
   * row; the row stays open and the inbox model decides, as the inbox does. `step` asks the agent to run a step's
   * command. `fix` and `issue` hand a finding to the agent. `explain` asks the agent what a row is about; the row
   * stays open on the turn that explains it.
   */
  action: 'answer' | 'reply' | 'done' | 'dismiss' | 'step' | 'fix' | 'issue' | 'explain'
  /** The option, for `answer`, or the typed words, for `reply`. */
  answer?: string
  /** For `step`: its place among the row's steps and its label, which must still match. */
  step?: { index: number; label: string }
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

/** What a row is drawn with, beside its terminal and session. */
export function drawnToken(s: SessionState): string {
  return JSON.stringify([s.lastTurnId, s.queue.map(t => t.turnId)])
}

/**
 * A message on one line: a newline would submit early. Other control characters, such as ESC or Ctrl-C, are
 * dropped: row text comes from an agent, and the terminal could act on them.
 */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim()
}

/**
 * The inbox mod's message for typed words, by the row's kind (`messages.answer` and `messages.taskReply` in the inbox
 * repo's `hooks/presses.ts`), on one line: a newline would submit early. An option press sends `messages.answer` too.
 */
export function answerText(item: Item, answer: string): string {
  return oneLine(item.kind === 'task' ? `Re the task you left for me, "${item.ask}": ${answer}` : `Re "${item.ask}": ${answer}`)
}

/** The inbox mod's message for an Explain press on a question or task (`messages.explain` in `hooks/presses.ts`), on one line. */
export function explainText(item: Item): string {
  const what =
    item.kind === 'task'
      ? 'this task you left for me is about: why it came up, and what each choice would mean'
      : 'this question you asked me is about: why it came up, what each choice would mean, and which you would pick'
  const options = item.options.length > 0 ? `\nOptions: ${item.options.join(' / ')}` : ''
  return oneLine(`Remind me what ${what}. Don't act on it yet.\n"${item.ask}"${options}`)
}

/** The inbox mod's message for a step's command (`messages.run` in `hooks/presses.ts`), on one line. */
export function runText(item: Item, command: string): string {
  return oneLine(`For "${item.ask}", run this:\n\`\`\`\n${command}\n\`\`\``)
}

/** `ISSUE_LABEL` in the inbox repo's `hooks/presses.ts`. */
export const ISSUE_LABEL = 'File issue'

/** The Explain button's label. */
export const EXPLAIN_LABEL = 'Explain'

/** `findingBody` in `hooks/presses.ts`. */
function findingBody(finding: Finding): string[] {
  return [
    `${finding.kind === 'issue' ? 'Issue' : 'Opportunity'}: ${finding.title}`,
    finding.detail,
    ...(finding.path ? [`File: ${finding.path}`] : []),
  ]
}

/** The inbox mod's message for a finding (`messages.finding` in `hooks/presses.ts`, less Discuss), on one line. */
export function findingText(finding: Finding, how: 'address' | 'issue' | 'explain' | 'typed', words = ''): string {
  const opening =
    how === 'address'
      ? 'Please address this finding you recorded:'
      : how === 'issue'
        ? "Please file an issue for this finding you recorded, in the issue tracker you have tools for. First check whether one already exists, and if it does, use it instead of filing a duplicate. Then close the finding with the issue's key or number as the reason, and give me its link. If you have no tools for an issue tracker, say so and leave the finding open."
        : how === 'explain'
          ? "Remind me what this finding you recorded is about: why it matters, what fixing it would involve, and whether you would fix it now. Don't act on it yet."
          : 'About this finding you recorded:'
  return oneLine([opening, ...findingBody(finding), ...(how === 'typed' ? ['', words] : [])].join('\n'))
}

type Send = { kind: PressLabel['kind']; answer: string; text: string }

/** The message a finding's press sends, or null when the press sends nothing. */
function findingSend(finding: Finding, p: PressInput): Send | null {
  if (p.action === 'fix') return { kind: 'fix', answer: fixLabel(finding), text: findingText(finding, 'address') }
  if (p.action === 'issue') return { kind: 'issue', answer: ISSUE_LABEL, text: findingText(finding, 'issue') }
  if (p.action === 'explain') return { kind: 'explain', answer: EXPLAIN_LABEL, text: findingText(finding, 'explain') }
  const words = p.action === 'reply' ? (p.answer?.trim() ?? '') : ''
  return words ? { kind: 'reply', answer: words, text: findingText(finding, 'typed', words) } : null
}

/** The message a press sends and what its label records, or null when the press is stale or sends nothing. */
function sendOf(ledger: Ledger, p: PressInput): Send | null {
  const finding = ledger.findings.find(f => f.id === p.id)
  if (finding) return findingSend(finding, p)
  const item = ledger.items.find(i => i.id === p.id)
  if (!item) return null
  if (p.action === 'step') {
    const step = p.step ? stepsOf(item.helps)[p.step.index] : undefined
    if (!step || step.label !== p.step?.label) return null
    const run = step.helps.find(h => h.kind === 'run')
    return run ? { kind: 'step', answer: step.label, text: runText(item, run.command) } : null
  }
  if (p.action === 'explain') return { kind: 'explain', answer: EXPLAIN_LABEL, text: explainText(item) }
  const words = p.answer?.trim() ?? ''
  // An option must still be one of the question's options, as the inbox's `applyPress` checks.
  if (p.action === 'answer') return item.kind === 'question' && item.options.includes(words) ? { kind: 'answer', answer: words, text: answerText(item, words) } : null
  if (p.action !== 'reply' || !words) return null
  return { kind: 'reply', answer: words, text: answerText(item, words) }
}

/**
 * The label once the prompt shows, as the inbox's `feedbackText` gives a sent press: "✓ " and the press's done
 * label from `DONE_LABELS` in `hooks/view.ts`, or the option itself, which is its button label.
 */
const DONE_TEXT: Record<PressLabel['kind'], (label: PressLabel) => string> = {
  answer: label => `✓ ${label.answer}`,
  reply: () => '✓ Replied',
  step: label => `✓ Handed off: ${label.answer}`,
  fix: () => '✓ Handed off',
  issue: () => '✓ Asked to file',
  explain: () => '✓ Explained',
}

export function rowLabel(label: PressLabel): RowLabel {
  switch (label.state) {
    case 'sending':
      return { text: label.kind === 'explain' ? 'Explaining…' : 'Sending…', tone: 'muted', copy: null }
    case 'answered':
      return { text: DONE_TEXT[label.kind](label), tone: 'success', copy: null }
    case 'held':
      return { text: 'Waits for the agent', tone: 'muted', copy: label.text }
    case 'undelivered':
      return { text: 'Not delivered', tone: 'danger', copy: label.text }
  }
}

/** The session's open rows, findings and closed lists, from nowRows and findingRows, each open row with its press label. */
export function labelledRows(
  s: SessionState,
  now = 0,
): { questions: LabelledRow[]; tasks: LabelledRow[]; closed: NowGroups['closed']; findings: LabelledFindings } {
  const { questions, tasks, closed } = nowRows(s.ledger, now)
  // A Fix moves to the closed list once its prompt shows, as the inbox's `isFixSent` moves it while its delivery has
  // not failed. Held and undelivered fixes stay open.
  const fixesSent = Object.fromEntries(
    Object.entries(s.presses).flatMap(([id, l]) => (l.kind === 'fix' && l.state === 'answered' ? [[id, l.at]] : [])),
  )
  const found = findingRows(s.ledger, now, fixesSent)
  const label = (id: string) => (s.presses[id] && s.presses[id].state !== 'held' ? rowLabel(s.presses[id]) : null)
  const explained = (id: string) => s.presses[id]?.kind === 'explain'
  const add = (r: NowRow): LabelledRow => ({ ...r, label: label(r.id), explained: explained(r.id) })
  const addFinding = (r: FindingRow): LabelledFinding => ({ ...r, label: label(r.id), explained: explained(r.id) })
  return {
    questions: questions.map(add),
    tasks: tasks.map(add),
    closed,
    findings: { issues: found.issues.map(addFinding), opportunities: found.opportunities.map(addFinding), closed: found.closed },
  }
}

/** True while the item or finding is open. */
export function isOpenRow(ledger: Ledger, id: string): boolean {
  return ledger.items.some(i => i.id === id) || ledger.findings.some(f => f.id === id)
}

/** The send check, in one tick. Null when the send may go, else why it holds. */
export function sendCheck(state: State, p: PressInput): string | null {
  if (state.terminals[p.terminalId]?.sessionId !== p.sessionId) return 'the terminal has another session'
  const s = state.sessions[p.sessionId]
  if (!s) return 'the session is missing'
  const paneKey = state.terminals[p.terminalId]?.paneKey
  if (s.agent === 'codex' && (state.version === 1 || !paneKey || state.panes[paneKey]?.threadId !== p.sessionId || !state.panes[paneKey]?.promptHookSeen))
    return 'Trust the Agent Inbox hook in Codex to send answers'
  return null
}

/**
 * A Fix closes the question that asks about its finding, as the 'address' press in the inbox's `hooks/presses.ts`
 * does when it sends: the question is answered by the fix.
 */
function closeAsker(s: SessionState, findingId: string, now: number): SessionState {
  const asker = s.ledger.findings.find(f => f.id === findingId)?.askedAs
  if (!asker || !s.ledger.items.some(i => i.id === asker)) return s
  return { ...s, ledger: closeItem(s.ledger, asker, { how: 'update', outcome: `fix sent for ${findingId}` }, now) }
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
      return cur && cur.at === at && isOpenRow(s.ledger, id) ? setLabel(s, id, { ...cur, ...change }) : s
    })
  }

  /** Reads the transcript until the prompt appears, or for CONFIRM_MS after the agent is done. */
  async function confirm(terminalId: string, sessionId: string, id: string, label: PressLabel): Promise<void> {
    let deadline: number | null = null
    for (;;) {
      const bytes = await deps.read(sessionId)
      const prompt = bytes ? deps.state().sessions[sessionId]?.agent === 'codex'
        ? codexPromptAfter(bytes, label.from ?? 0, label.text)
        : promptAfter(bytes, label.from ?? 0, label.text) : null
      const done = deps.status(terminalId) === 'done'
      if (prompt)
        return settle(sessionId, id, label.at, { state: 'answered', turnId: prompt.uuid })
      // A queued answer has no transcript prompt until the current turn ends.
      if (done) {
        deadline ??= clock.now() + CONFIRM_MS
        const otherPrompt = bytes ? deps.state().sessions[sessionId]?.agent === 'codex'
          ? codexPromptAfter(bytes, label.from ?? 0)
          : promptAfter(bytes, label.from ?? 0) : null
        if (otherPrompt || clock.now() >= deadline) return settle(sessionId, id, label.at, { state: 'undelivered' })
      } else deadline = null
      await clock.sleep(CONFIRM_POLL_MS)
    }
  }

  return {
    async press(p: PressInput): Promise<PressOutcome> {
      const before = deps.state().sessions[p.sessionId]
      if (!before) return { ok: false, refused: 'invalid' }
      if (!isOpenRow(before.ledger, p.id)) return { ok: false, refused: 'closed' }
      const isFinding = before.ledger.findings.some(f => f.id === p.id)

      if (p.action === 'dismiss' || (p.action === 'done' && !isFinding)) {
        const how = p.action === 'done' ? 'done' : 'dismissed'
        const close = isFinding ? closeFinding : closeItem
        await deps.edit(p.sessionId, s => ({ ...s, ledger: close(s.ledger, p.id, { how, outcome: how }, clock.now()) }))
        return { ok: true, label: null }
      }

      if (!sendOf(before.ledger, p)) return { ok: false, refused: 'invalid' }
      // Where the answer's prompt will start. Read before the check, so nothing waits between the check and the send.
      const bytes = await deps.read(p.sessionId)

      // From here to the send: one tick.
      const state = deps.state()
      const s = state.sessions[p.sessionId]
      if (!s || !isOpenRow(s.ledger, p.id)) return { ok: false, refused: 'closed' }
      const sent = sendOf(s.ledger, p)
      if (!sent) return { ok: false, refused: 'invalid' }
      const label: PressLabel = { state: 'sending', ...sent, at: clock.now() }
      if (s.agent === 'codex') label.paneKey = state.terminals[p.terminalId]?.paneKey
      const why = sendCheck(state, p)
      if (why) {
        deps.log?.(`press: held for ${p.id}: ${why}`)
        const held = { ...label, state: 'held' as const }
        await deps.edit(p.sessionId, cur => setLabel(cur, p.id, held))
        return { ok: true, label: rowLabel(held) }
      }
      label.from = bytes?.length ?? 0
      const saving = deps.edit(p.sessionId, cur => setLabel(sent.kind === 'fix' ? closeAsker(cur, p.id, label.at) : cur, p.id, label))
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
      void confirm(p.terminalId, p.sessionId, p.id, label).catch(e => deps.log?.(`press: ${e instanceof Error ? e.message : String(e)}`))
      return { ok: true, label: rowLabel(label) }
    },
  }
}

export type Presses = ReturnType<typeof createPresses>
