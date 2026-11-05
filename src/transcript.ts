// Reads one turn of a Claude Code transcript (JSONL) into the Exchange the inbox model takes.
// docs/transcript-format.md records the line shapes this relies on.
//
// readTurn judges only the bytes it is given. The quiet rule (2 s with no growth), the 15 s
// limit and the retries belong to the turn tracker (T4), so no clock is read here.
import { readFileSync } from 'node:fs'

import { addActivity, dialogActivity, dialogQuestions, toolActivity } from './core/model-text'
import type { DialogOutcome } from './core/model-text'
import type { Exchange } from './core/types'

export type TurnRead = {
  /** complete: a final reply after the prompt, no tool call open. incomplete: a later prompt came first. */
  status: 'complete' | 'pending' | 'incomplete'
  /** The uuid of the line that started the turn. */
  turnId: string
  exchange: Exchange
  /** Where the next read starts: the next turn's first line, or the end of the lines read. A pending turn keeps the offset it was given. */
  nextOffset: number
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
type Line = {
  type?: string
  uuid?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  turnPosition?: unknown
  origin?: { kind?: string; asUser?: boolean }
  turnOrigin?: string
  toolUseResult?: unknown
  message?: { content?: string | Block[]; stop_reason?: string | null }
}

const NL = 0x0a
// The inbox mod's activity line for a local URL a shell command printed (inbox repo `hooks/session.ts`).
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[\w.-]+\.localhost)(?::\d+)?[^\s"'`)\]]*/g

/** The whole lines in `bytes` from `offset`, each with the byte where it starts. A half-written last line is left out. */
function lines(bytes: Buffer, offset: number): { at: number; line: Line | null }[] {
  const out: { at: number; line: Line | null }[] = []
  let at = offset
  for (let end = bytes.indexOf(NL, at); end !== -1; at = end + 1, end = bytes.indexOf(NL, at)) {
    const raw = bytes.toString('utf8', at, end)
    let line: Line | null = null
    try {
      line = raw.trim() === '' ? null : (JSON.parse(raw) as Line)
    } catch {
      line = null
    }
    out.push({ at, line })
  }
  out.push({ at, line: null }) // marks the end of the whole lines
  return out
}

function blocks(line: Line): Block[] {
  const c = line.message?.content
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content.flatMap((b: Block) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
    : ''
}

/** A line that starts a turn: a prompt with `turnPosition`, not a compaction summary, not a subagent's. */
export function isTurnStart(line: Line | null): boolean {
  return !!line && line.type === 'user' && !line.isSidechain && !line.isCompactSummary && line.turnPosition != null
}

/** The person's own words: typed, or sent by a plugin as theirs, as the inbox mod counts them. */
function isPerson(line: Line): boolean {
  const kind = line.origin?.kind
  return kind === 'human' || (kind === 'plugin' && line.origin?.asUser === true) || (!kind && line.turnOrigin === 'human')
}

/** The count of the person's prompts in the whole lines before `offset`. */
export function promptsBefore(bytes: Buffer, offset: number): number {
  return lines(bytes.subarray(0, offset), 0).filter(({ line }) => line && isTurnStart(line) && isPerson(line)).length
}

/** The inbox mod's activity line for an AskUserQuestion call, with its result when it has one. */
function dialogLine(input: Record<string, unknown>, result: Block | undefined, structured: unknown): string {
  return dialogActivity(dialogQuestions(input.questions), outcomeOf(result, structured))
}

function outcomeOf(result: Block | undefined, structured: unknown): DialogOutcome {
  if (!result) return { kind: 'open' }
  if (result.is_error) return { kind: 'dismissed' }
  const answer = text(result.content)
  const afk = structured && typeof structured === 'object' ? (structured as { afkTimeoutMs?: unknown }).afkTimeoutMs : undefined
  return typeof afk === 'number' ? { kind: 'timed-out', answer } : { kind: 'answered', answer }
}

/**
 * The first turn that starts at or after `offset` in `source` (the whole transcript), or null when no turn starts
 * there yet. `prompts` is the count of the person's prompts before `offset`; it is counted from the file when left out.
 *
 * The exchange's `screen` is empty and its `press` is null: the transcript does not know what the panel showed or
 * which press the turn answers. The turn tracker (T4) and the presses (T7) fill them.
 */
export function readTurn(source: Buffer | string, offset: number, prompts?: number): TurnRead | null {
  const bytes = typeof source === 'string' ? Buffer.from(source) : source
  const all = lines(bytes, offset)
  const start = all.findIndex(({ line }) => isTurnStart(line))
  if (start === -1) return null
  const first = all[start].line as Line
  const isPersonTurn = isPerson(first)

  const calls = new Map<string, Block>() // each tool call still without a result, by id
  let activity: string[] = []
  let reply: string[] = []
  let last: Line | null = null
  let next = -1
  for (let i = start + 1; i < all.length; i++) {
    const { line } = all[i]
    if (isTurnStart(line)) {
      next = i
      break
    }
    if (!line || line.isSidechain) continue
    if (line.type === 'assistant') {
      for (const b of blocks(line)) {
        if (b.type === 'tool_use' && b.id) {
          calls.set(b.id, b)
          reply = []
          const input = (b.input ?? {}) as Record<string, unknown>
          // A dialog reads as still open until its result comes.
          const note = b.name === 'AskUserQuestion' ? dialogLine(input, undefined, undefined) : toolActivity(String(b.name), input)
          activity = addActivity(activity, note)
        } else if (b.type === 'text' && !line.isApiErrorMessage && b.text?.trim()) reply = [...reply, b.text]
      }
      last = line
    } else if (line.type === 'user') {
      for (const b of blocks(line)) {
        const call = b.type === 'tool_result' && b.tool_use_id ? calls.get(b.tool_use_id) : undefined
        if (!call) continue
        calls.delete(b.tool_use_id as string)
        reply = []
        last = line
        const input = (call.input ?? {}) as Record<string, unknown>
        if (call.name === 'AskUserQuestion') {
          const open = activity.indexOf(dialogLine(input, undefined, undefined))
          if (open !== -1) activity = activity.with(open, dialogLine(input, b, line.toolUseResult))
        } else if (call.name === 'Bash' && !b.is_error) {
          for (const url of new Set(text(b.content).match(LOCAL_URL) ?? [])) activity = addActivity(activity, `URL in output: ${url}`)
        }
      }
    }
  }

  const hasReply = reply.length > 0 && calls.size === 0 && last?.type === 'assistant' && last.message?.stop_reason !== 'tool_use'
  const status = hasReply ? 'complete' : next !== -1 ? 'incomplete' : 'pending'
  const before = prompts ?? promptsBefore(bytes, offset)
  const exchange: Exchange = {
    person: isPersonTurn ? text(first.message?.content) : null,
    trigger: isPersonTurn ? null : (first.origin?.kind ?? first.turnOrigin ?? 'unknown'),
    activity,
    reply: status === 'complete' ? reply.join('\n\n') : '',
    turn: before + (isPersonTurn ? 1 : 0),
    press: null, // T7 sets it when the turn answers a press.
    screen: '', // T4 sets it from what the panel showed when the turn started.
  }
  const end = next !== -1 ? all[next].at : all[all.length - 1].at

  return { status, turnId: String(first.uuid), exchange, nextOffset: status === 'pending' ? offset : end }
}

/** readTurn over a transcript file. */
export function readTurnFile(path: string, offset: number, prompts?: number): TurnRead | null {
  return readTurn(readFileSync(path), offset, prompts)
}

/** The first prompt that starts at or after `offset`, with its uuid and text, or null: how a press confirms its answer arrived (plan T7). */
export function promptAfter(bytes: Buffer, offset: number): { uuid: string; text: string } | null {
  const found = lines(bytes, offset).find(({ line }) => isTurnStart(line))?.line
  return found ? { uuid: String(found.uuid), text: text(found.message?.content) } : null
}

/** Where the whole lines end: the byte after the last newline. A resumed session starts reading here. */
export function wholeLinesEnd(bytes: Buffer): number {
  return bytes.lastIndexOf(NL) + 1
}
