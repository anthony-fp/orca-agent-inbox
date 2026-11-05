import type { Item, Ledger } from './types'

/** One open item as the Now view shows it. T7 adds the press label. */
export type NowRow = { id: string; text: string; options: string[] }

/**
 * The open questions and tasks, newest reply first, as the inbox repo's Now view orders them.
 * Closed items live in `ledger.closed`, so they never show here.
 */
export function nowRows(ledger: Ledger): { questions: NowRow[]; tasks: NowRow[] } {
  const rows = (kind: Item['kind']) =>
    ledger.items
      .filter(i => i.kind === kind)
      .sort((a, b) => b.turn - a.turn)
      .map(i => ({ id: i.id, text: i.ask, options: i.options }))

  return { questions: rows('question'), tasks: rows('task') }
}
