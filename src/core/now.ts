import { closedState } from './ledger'
import { questionNumbers } from './model-text'
import { ago } from './text'
import type { Closed, ClosedFinding, Finding, Help, Item, Ledger } from './types'

/** Past this many options, a question shows its first four and an "All N options" button (`OPTIONS_FOLD_AT` in the inbox repo's `hooks/view.ts`). */
export const OPTIONS_FOLD_AT = 5
/** The closed rows a group shows when unfolded (`CLOSED_SHOWN` in `hooks/view.ts`). */
export const CLOSED_SHOWN = 3

/** One option button, as the inbox's `rowActions` builds it: the recommended option first, and folded past the limit. */
export type Choice = { option: string; label: string; isRec: boolean; isFolded: boolean }

/**
 * A one-press step toward finishing an item (`HelpStep` in the inbox repo's `hooks/presses.ts`). A step with a `run`
 * help hands off: it asks the agent to run the command. Every other step is local: it opens or copies.
 */
export type Step = { label: string; kind: 'handoff' | 'local'; helps: Help[] }

/** One open item as the Now view shows it. */
export type NowRow = {
  id: string
  /** "1)" for a question in the latest batch, else "": the inbox's row handle. */
  handle: string
  text: string
  /** The age as "2h", or null for an item saved without a time. */
  age: string | null
  /** The option the agent recommended, exactly as `options` has it. */
  rec: string | null
  choices: Choice[]
  steps: Step[]
}

/** One closed item, as the inbox's closed list shows it. */
export type ClosedRow = { id: string; mark: string; text: string; outcome: string; age: string }

export type ClosedGroup = { shown: ClosedRow[]; total: number }

export type NowGroups = {
  questions: NowRow[]
  tasks: NowRow[]
  closed: { questions: ClosedGroup; tasks: ClosedGroup }
}

/** `CLOSED_MARKS` in `hooks/view.ts`. */
const CLOSED_MARKS = { handled: '✓', dismissed: '✕', lapsed: '' } as const

/** `shortAgo` in `hooks/view.ts`: "2h", or "now". */
export function shortAgo(ms: number): string {
  const age = ago(ms)
  return age === 'just now' ? 'now' : age.replace(/ ago$/, '')
}

/** `clipLabel` in `hooks/presses.ts`. */
function clipLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `baseName` in `hooks/presses.ts`. */
function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

/** `helpLabel` in `hooks/presses.ts`. */
export function helpLabel(help: Help): string {
  const label =
    help.kind === 'open'
      ? `Open ${baseName(help.path)}`
      : help.kind === 'copy'
        ? `Copy ${help.name ?? 'snippet'}`
        : help.kind === 'run'
          ? `Run ${help.name ?? help.command}`
          : help.kind === 'terminal'
            ? `Copy ${help.name ?? help.command}`
            : `Open ${help.name ?? new URL(help.url).host}`

  return clipLabel(label, 32)
}

/** An item's steps, as `steps` in `hooks/presses.ts` builds them: a copy and an open join into one step. */
export function stepsOf(helps: Help[]): Step[] {
  const step = (label: string, step: Help[]): Step => ({
    label,
    kind: step.some(h => h.kind === 'run') ? 'handoff' : 'local',
    helps: step,
  })
  const copy = helps.find(h => h.kind === 'copy')
  const open = helps.find(h => h.kind === 'open')
  if (!copy || !open || copy.kind !== 'copy' || open.kind !== 'open') return helps.map(h => step(helpLabel(h), [h]))

  return helps
    .filter(h => h !== copy)
    .map(h =>
      h === open
        ? step(clipLabel(`Copy ${copy.name ?? 'snippet'} and open ${baseName(open.path)}`, 48), [copy, open])
        : step(helpLabel(h), [h]),
    )
}

/** The option buttons in the inbox's order (`rowActions` in `hooks/view.ts`). */
export function choices(item: Pick<Item, 'options' | 'rec'>): Choice[] {
  const isFolding = item.options.length > OPTIONS_FOLD_AT
  const options =
    item.rec && item.options.includes(item.rec) ? [item.rec, ...item.options.filter(o => o !== item.rec)] : item.options
  return options.map((option, n) => ({
    option,
    label: clipLabel(option, 32),
    isRec: option === item.rec,
    isFolded: isFolding && n >= OPTIONS_FOLD_AT - 1,
  }))
}

/**
 * The open questions and tasks, newest reply first, and each group's closed items, newest first, as the inbox repo's
 * Now view shows them. Closed items live in `ledger.closed`, so they never show as open rows.
 */
export function nowRows(ledger: Ledger, now = 0): NowGroups {
  const numbers = questionNumbers(ledger, ledger.turn + 1)
  const age = (at: number | null) => (at === null ? null : shortAgo(now - at))
  const rows = (kind: Item['kind']): NowRow[] =>
    ledger.items
      .filter(i => i.kind === kind)
      .sort((a, b) => b.turn - a.turn)
      .map(i => {
        const n = numbers.get(i.id)
        return { id: i.id, handle: n === undefined ? '' : `${n})`, text: i.ask, age: age(i.at), rec: i.rec, choices: choices(i), steps: stepsOf(i.helps) }
      })
  const closed = (kind: Item['kind']): ClosedGroup => {
    const all = ledger.closed.filter(c => c.kind === kind).reverse()
    const row = (c: Closed): ClosedRow => ({
      id: c.id,
      mark: CLOSED_MARKS[closedState(c)],
      text: c.ask,
      outcome: c.outcome.charAt(0).toUpperCase() + c.outcome.slice(1),
      age: shortAgo(now - c.at),
    })
    return { shown: all.slice(0, CLOSED_SHOWN).map(row), total: all.length }
  }

  return { questions: rows('question'), tasks: rows('task'), closed: { questions: closed('question'), tasks: closed('task') } }
}

/** Each finding kind's group and the mark before its row (`FINDING_GROUPS` in `hooks/view.ts`). */
export const FINDING_GROUPS: Record<Finding['kind'], { title: string; mark: string }> = {
  issue: { title: 'Issues', mark: '▲' },
  opportunity: { title: 'Opportunities', mark: '✦' },
}

/** One open finding as the Now view shows it (the finding rows of `inboxView` in `hooks/view.ts`). */
export type FindingRow = {
  id: string
  kind: Finding['kind']
  mark: string
  title: string
  detail: string
  /** The file's name, as `baseName` gives it, or null. */
  fileName: string | null
  age: string
  /** The first button: "Fix" on an issue, "Do it" on an opportunity (`fixLabel` in `hooks/view.ts`). */
  fix: string
}

export type FindingGroups = {
  issues: FindingRow[]
  opportunities: FindingRow[]
  closed: { issues: ClosedGroup; opportunities: ClosedGroup }
}

/** `fixLabel` in `hooks/view.ts`. */
export const fixLabel = (f: Pick<Finding, 'kind'>) => (f.kind === 'opportunity' ? 'Do it' : 'Fix')

/**
 * The open findings, newest first, and each kind's closed findings, newest closed first, as the inbox's Now view shows them.
 * `fixesSent` gives, by id, when a Fix or Do it reached the agent: that finding stays open in the ledger, for the agent
 * and the inbox model to close, but shows as closed with its button's label, as `fixesSent` in `hooks/view.ts` does.
 */
export function findingRows(ledger: Ledger, now = 0, fixesSent: Record<string, number> = {}): FindingGroups {
  const sent = ledger.findings
    .filter(f => fixesSent[f.id] !== undefined)
    .map((f): ClosedFinding => ({ ...f, how: 'answered', outcome: fixLabel(f), closedAt: fixesSent[f.id]! }))
  const open = (kind: Finding['kind']): FindingRow[] =>
    [...ledger.findings]
      .reverse()
      .filter(f => f.kind === kind && fixesSent[f.id] === undefined)
      .map(f => ({
        id: f.id,
        kind: f.kind,
        mark: FINDING_GROUPS[kind].mark,
        title: f.title,
        detail: f.detail,
        fileName: f.path ? baseName(f.path) : null,
        age: shortAgo(now - f.at),
        fix: fixLabel(f),
      }))
  const closed = (kind: Finding['kind']): ClosedGroup => {
    const all = [...ledger.closedFindings, ...sent].filter(f => f.kind === kind).sort((a, b) => b.closedAt - a.closedAt)
    // `outcomeLabel` in `hooks/view.ts`: a finding a question replaced says where it went.
    const row = (f: ClosedFinding): ClosedRow => ({
      id: f.id,
      mark: CLOSED_MARKS[closedState(f)],
      text: f.title,
      outcome: f.askedAs ? 'Now a question' : f.outcome.charAt(0).toUpperCase() + f.outcome.slice(1),
      age: shortAgo(now - f.closedAt),
    })
    return { shown: all.slice(0, CLOSED_SHOWN).map(row), total: all.length }
  }

  return { issues: open('issue'), opportunities: open('opportunity'), closed: { issues: closed('issue'), opportunities: closed('opportunity') } }
}
