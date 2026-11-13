// Reads Codex's session transcript, a JSONL file whose path every hook gets.

import { readFileSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { flattenConversation } from './codex-conversation'
import type { Turn } from './codex-conversation'
import { addActivity, dialogActivity, dialogQuestions } from './model-text'
import type { DialogQuestion } from './model-text'
import type { Exchange } from './types'
import { activityOf, patchFiles } from './codex-activity'

type SessionMeta = {
  type?: string
  payload?: {
    originator?: string
    source?: string
    forked_from_id?: unknown
    parent_thread_id?: unknown
    cwd?: unknown
  }
}

/** The rollout's first row, `session_meta`. Null when the file or the row cannot be read. */
async function readSessionMeta(path: string): Promise<SessionMeta | null> {
  try {
    const file = await open(path, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(buf, 0, buf.length, 0)
      const first = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
      const meta = JSON.parse(first) as SessionMeta

      return meta.type === 'session_meta' ? meta : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/**
 * Whether the session is a run no person chats in, where the hooks do nothing.
 * An ephemeral thread, such as the Codex app's own background jobs that
 * suggest a next message, saves no transcript, so its hooks get a null path.
 * A `codex exec` run names its originator in the transcript's first line,
 * `session_meta`, which covers the inbox's own update call and runs other
 * tools start.
 */
export async function isNonInteractiveRun(path: string | null): Promise<boolean> {
  if (path === null) return true

  return isExecMeta(await readSessionMeta(path))
}

function isExecMeta(meta: SessionMeta | null): boolean {
  return meta?.payload?.originator === 'codex_exec' || meta?.payload?.source === 'exec'
}

/**
 * The session a forked chat was forked from, from `forked_from_id` in the rollout's first row. A fork's rollout also
 * holds the parent's own `session_meta` later on, so only the first row counts.
 */
export async function forkedFromId(path: string): Promise<string | null> {
  const id = (await readSessionMeta(path))?.payload?.forked_from_id

  return typeof id === 'string' && id !== '' ? id : null
}

/** The names under `dir` that match `pattern`, newest first. Empty when the folder cannot be read. */
async function namesIn(dir: string, pattern: RegExp): Promise<string[]> {
  const names = await readdir(dir).catch(() => [])

  return names
    .filter(n => pattern.test(n))
    .sort()
    .reverse()
}

/**
 * A chat's rollout, found by its thread id in Codex's `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. Null
 * when no readable file holds it, or when the newest one belongs to a subagent or a run no person chats in. A rollout
 * Codex has compressed (`.zst`) is not read. `cwd` is the folder the chat runs in, from its first row.
 */
export async function rolloutFor(codexHome: string, threadId: string): Promise<{ path: string; cwd: string } | null> {
  if (threadId === '') return null
  const sessions = join(codexHome, 'sessions')
  const suffix = `-${threadId}.jsonl`
  for (const year of await namesIn(sessions, /^\d{4}$/))
    for (const month of await namesIn(join(sessions, year), /^\d{2}$/))
      for (const day of await namesIn(join(sessions, year, month), /^\d{2}$/)) {
        const folder = join(sessions, year, month, day)
        const [name] = (await namesIn(folder, /^rollout-.+\.jsonl$/)).filter(n => n.endsWith(suffix))
        if (name === undefined) continue
        const path = join(folder, name)
        const meta = await readSessionMeta(path)
        const isOwnChat = meta !== null && !meta.payload?.parent_thread_id && !isExecMeta(meta)

        return isOwnChat ? { path, cwd: typeof meta.payload?.cwd === 'string' ? meta.payload.cwd : '' } : null
      }

  return null
}

const DIALOG_TOOL = 'request_user_input_async'

const TAIL_BYTES = 4 * 1024 * 1024

/** A shell command that finished, with the text it printed. */
export type FinishedCommand = { command: string; output: string }

type RowPayload = NonNullable<TranscriptLine['payload']>

type TranscriptLine = {
  type?: string
  payload?: {
    type?: string
    name?: string
    arguments?: unknown
    turn_id?: string
    call_id?: string
    output?: unknown
    action?: { command?: unknown }
    item?: { type?: string; command?: unknown; aggregated_output?: unknown }
  }
}

const SHELL_CALLS = new Set(['shell', 'shell_command', 'exec_command', 'container.exec'])
const MARKERS = ['"task_started"', DIALOG_TOOL, '"CommandExecution"', '"function_call', '"local_shell_call']

const isText = (v: unknown): v is string => typeof v === 'string'

/** The command line of an argv such as `["/bin/zsh", "-lc", "gh pr create"]`, without its shell wrapper. */
function commandText(command: unknown): string {
  if (isText(command)) return command
  if (!Array.isArray(command)) return ''
  const argv = command.filter(isText)
  const [, flag, script] = argv

  return argv.length === 3 && flag?.startsWith('-') && flag.endsWith('c') && script !== undefined
    ? script
    : argv.join(' ')
}

/** A function call's output is its text, or JSON holding the text as `output`. */
function outputText(output: unknown): string {
  if (!isText(output)) return ''
  try {
    const parsed = JSON.parse(output) as { output?: unknown }

    return isText(parsed.output) ? parsed.output : output
  } catch {
    return output
  }
}

function callCommand(p: NonNullable<TranscriptLine['payload']>): string {
  if (p.type === 'local_shell_call') return commandText(p.action?.command)
  if (p.type !== 'function_call' || !p.name || !SHELL_CALLS.has(p.name) || !isText(p.arguments)) return ''
  try {
    const args = JSON.parse(p.arguments) as { command?: unknown; cmd?: unknown }

    return commandText(args.command ?? args.cmd)
  } catch {
    return ''
  }
}

/** The last `bytes` of a file as lines. A cut first line is dropped. */
async function tailLines(path: string, bytes: number): Promise<string[]> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(buf, 0, buf.length, start)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start > 0) lines.shift()

    return lines
  } finally {
    await file.close()
  }
}

type TurnRows = { dialogs: DialogQuestion[][]; commands: FinishedCommand[] }

/**
 * What the agent did in a turn, oldest first, read from the transcript. Codex runs no hook for its dialog tool,
 * and a shell command's output reaches no hook at all when the command runs long, so both show only here.
 * The turn is the one with `turnId`, or the newest when none is given. Only the last few megabytes are read. When
 * they hold no turn start, they count as the turn. A transcript that cannot be read gives an empty turn.
 *
 * `dialogs` holds the questions of each dialog, and the answer arrives later as the person's next prompt.
 * `commands` holds each shell command that finished. The `CommandExecution` rows of Codex CLI 0.163 and later give
 * them. A turn with none falls back to older shell calls and their outputs.
 */
export async function turnIn(path: string | null, turnId: string | undefined): Promise<TurnRows> {
  const none: TurnRows = { dialogs: [], commands: [] }
  if (path === null) return none
  try {
    const lines = await tailLines(path, TAIL_BYTES)
    type Turn = {
      dialogs: DialogQuestion[][]
      executions: FinishedCommand[]
      calls: Map<string, FinishedCommand>
      called: FinishedCommand[]
    }
    const byTurn = new Map<string, Turn>()
    const newTurn = (): Turn => ({ dialogs: [], executions: [], calls: new Map(), called: [] })
    let current = ''
    let newest = ''
    for (const line of lines) {
      if (!MARKERS.some(m => line.includes(m))) continue
      let row: TranscriptLine
      try {
        row = JSON.parse(line) as TranscriptLine
      } catch {
        continue
      }
      const p = row.payload
      if (!p) continue
      if (row.type === 'event_msg' && p.type === 'task_started' && p.turn_id) {
        current = p.turn_id
        newest = current
        if (!byTurn.has(current)) byTurn.set(current, newTurn())
        continue
      }
      const turn = byTurn.get(current) ?? newTurn()
      byTurn.set(current, turn)
      if (row.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
        const output = p.item.aggregated_output
        turn.executions.push({ command: commandText(p.item.command), output: isText(output) ? output : '' })
      } else if (row.type === 'response_item' && p.type === 'function_call' && p.name === DIALOG_TOOL) {
        let args: { questions?: unknown }
        try {
          args = JSON.parse(isText(p.arguments) ? p.arguments : '') as { questions?: unknown }
        } catch {
          continue
        }
        turn.dialogs.push(dialogQuestions(args.questions))
      } else if (row.type === 'response_item' && (p.type === 'function_call' || p.type === 'local_shell_call')) {
        const command = callCommand(p)
        if (command !== '' && p.call_id) turn.calls.set(p.call_id, { command, output: '' })
      } else if (row.type === 'response_item' && p.type === 'function_call_output' && p.call_id) {
        const call = turn.calls.get(p.call_id)
        if (call) turn.called.push({ command: call.command, output: outputText(p.output) })
      }
    }
    const wanted = newest === '' ? '' : (turnId ?? newest)
    const turn = byTurn.get(wanted)
    if (!turn) return none

    return {
      dialogs: turn.dialogs.filter(questions => questions.length > 0),
      commands: turn.executions.length > 0 ? turn.executions : turn.called,
    }
  } catch {
    return none
  }
}

const ROLLOUT_BYTES = 8 * 1024 * 1024

type Payload = Record<string, unknown>

type RolloutRow = { type?: unknown; timestamp?: unknown; payload?: Payload }

const record = (v: unknown): Payload => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {})

const textOf = (v: unknown): string => (isText(v) ? v : '')

const contentText = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .map(part => textOf(record(part).text))
    .filter(Boolean)
    .join('\n')
    .trim()

const jsonRecord = (raw: unknown): Payload => {
  try {
    return record(JSON.parse(textOf(raw)))
  } catch {
    return {}
  }
}

/** The value of a JavaScript string literal, as the code-mode `exec` tool's input writes its arguments. */
const literalValue = (literal: string | undefined): string | null => {
  if (literal === undefined) return null
  try {
    return textOf(JSON.parse(literal))
  } catch {
    return null
  }
}

const PATCH_ARGUMENT = /tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*")/
const COMMAND_ARGUMENT = /\bcmd:\s*("(?:[^"\\]|\\.)*")/

const shellLines = (command: string): string[] => {
  const line = command === '' ? null : activityOf('Bash', { command })

  return line ? [line] : []
}

const editLines = (patch: string, cwd: string): string[] =>
  patchFiles(patch).map(file => `edited ${resolve(cwd || '/', file)}`)

/**
 * The activity lines of one tool call row. A call that a `CommandExecution` row also records gives no shell line, so
 * a command is not counted twice.
 */
function callLines(p: Payload, hasCommandRows: boolean, cwd: string): string[] {
  const name = textOf(p.name)
  if (p.type === 'local_shell_call') return hasCommandRows ? [] : shellLines(callCommand(p as RowPayload))
  if (p.type === 'custom_tool_call' && name === 'exec') {
    const input = textOf(p.input)
    const patch = literalValue(PATCH_ARGUMENT.exec(input)?.[1])
    const command = literalValue(COMMAND_ARGUMENT.exec(input)?.[1])

    return [...(patch ? editLines(patch, cwd) : []), ...(command && !hasCommandRows ? shellLines(command) : [])]
  }
  if (p.type !== 'function_call') return []
  if (SHELL_CALLS.has(name)) return hasCommandRows ? [] : shellLines(callCommand(p as RowPayload))
  const args = jsonRecord(p.arguments)
  if (name === 'apply_patch') return editLines(textOf(args.input ?? args.patch ?? args.command), cwd)
  if (name === 'spawn_agent') {
    const line = activityOf('Agent', { description: textOf(args.task_name) })

    return line ? [line] : []
  }
  if (name === DIALOG_TOOL) return [dialogActivity(dialogQuestions(args.questions), { kind: 'open' })]
  const line = activityOf(textOf(p.namespace).startsWith('mcp__') ? textOf(p.namespace) + name : name, {})

  return line ? [line] : []
}

const isItem = (row: RolloutRow, ...kinds: string[]): boolean =>
  row.type === 'event_msg' &&
  record(row.payload).type === 'item_completed' &&
  kinds.includes(textOf(record(record(row.payload).item).type))

/**
 * The conversation of one turn's rows. Codex 0.163 writes each message twice, as an item and as a `response_item`,
 * so the `response_item` copy is read only when the turn has no item rows.
 */
function turnsOf(rows: RolloutRow[], cwd: string): Turn[] {
  const hasMessageRows = rows.some(row => isItem(row, 'UserMessage', 'AgentMessage'))
  const hasCommandRows = rows.some(row => isItem(row, 'CommandExecution'))
  const turns: Turn[] = []
  const agentTurn = (): Turn => {
    const last = turns.at(-1)
    if (last?.role === 'agent') return last
    const turn: Turn = { role: 'agent', text: '', activity: [] }
    turns.push(turn)

    return turn
  }
  const person = (text: string) => {
    if (text && !text.startsWith('<')) turns.push({ role: 'person', text, activity: [] })
  }
  const act = (lines: string[]) => {
    if (lines.length === 0) return
    const turn = agentTurn()
    turn.activity = lines.reduce((all, line) => addActivity(all, line), turn.activity)
  }
  for (const row of rows) {
    const p = record(row.payload)
    const item = record(p.item)
    if (isItem(row, 'UserMessage')) person(contentText(item.content))
    else if (isItem(row, 'AgentMessage')) turns.push({ role: 'agent', text: contentText(item.content), activity: [] })
    else if (isItem(row, 'CommandExecution')) act(shellLines(commandText(item.command)))
    else if (row.type === 'response_item') {
      if (p.type === 'message' && !hasMessageRows && p.role === 'user') person(contentText(p.content))
      else if (p.type === 'message' && !hasMessageRows && p.role === 'assistant')
        turns.push({ role: 'agent', text: contentText(p.content), activity: [] })
      else act(callLines(p, hasCommandRows, cwd))
    }
  }

  return turns
}

type RolloutTurn = { id: string; isComplete: boolean; turns: Turn[] }

/** Splits the rollout into its turns, each from a `task_started` row to the next. Rows that are not JSON are skipped. */
function rolloutTurns(lines: string[], cwd: string): RolloutTurn[] {
  const groups: { id: string; isComplete: boolean; rows: RolloutRow[] }[] = []
  for (const line of lines) {
    let row: RolloutRow
    try {
      row = record(JSON.parse(line)) as RolloutRow
    } catch {
      continue
    }
    const p = record(row.payload)
    if (row.type === 'event_msg' && p.type === 'task_started') {
      groups.push({ id: textOf(p.turn_id) || textOf(record(p.turn_attribution).turn_id), isComplete: false, rows: [] })
      continue
    }
    if (groups.length === 0) groups.push({ id: '', isComplete: false, rows: [] })
    const group = groups.at(-1)!
    if (row.type === 'event_msg' && p.type === 'task_complete') group.isComplete = true
    else group.rows.push(row)
  }

  return groups.map(g => ({ id: g.id, isComplete: g.isComplete, turns: turnsOf(g.rows, cwd) }))
}

export type Rollout = {
  /** The whole conversation, oldest first, as the inbox model reads it. */
  conversation: string
  /** How many turns other than the current one finished or hold a person's message. */
  earlierTurns: number
}

/**
 * The session's conversation, read from its rollout. A rollout over a few megabytes keeps its newest part. Codex does
 * not document the rollout, so a row of a kind not read is skipped. `currentTurnId` names the turn a hook runs in, which
 * is not an earlier turn. Null when the file cannot be read.
 */
export async function readRollout(path: string | null, cwd: string, currentTurnId?: string): Promise<Rollout | null> {
  if (path === null) return null
  try {
    const turns = rolloutTurns(await tailLines(path, ROLLOUT_BYTES), cwd)
    const earlier = turns.filter(
      t => t.id !== currentTurnId && (t.isComplete || t.turns.some(x => x.role === 'person')),
    )

    return { conversation: flattenConversation(turns.flatMap(t => t.turns)), earlierTurns: earlier.length }
  } catch {
    return null
  }
}

export type CodexTurnRead = {
  status: 'complete' | 'pending' | 'incomplete'
  turnId: string
  exchange: Exchange
  nextOffset: number
}

/** One whole JSONL row and its byte boundaries. An unfinished final row is left for the next read. */
function wholeRows(bytes: Buffer): { at: number; end: number; row: RolloutRow }[] {
  const rows: { at: number; end: number; row: RolloutRow }[] = []
  for (let at = 0, end = bytes.indexOf(10, at); end !== -1; at = end + 1, end = bytes.indexOf(10, at)) {
    try {
      rows.push({ at, end: end + 1, row: record(JSON.parse(bytes.toString('utf8', at, end))) as RolloutRow })
    } catch {
      // Unknown or malformed whole rows do not affect turn boundaries.
    }
  }

  return rows
}

const isStart = (row: RolloutRow): boolean => row.type === 'event_msg' && record(row.payload).type === 'task_started'
const isComplete = (row: RolloutRow): boolean => row.type === 'event_msg' && record(row.payload).type === 'task_complete'

/** The next Codex turn at a byte offset, with the same durable queue contract as readTurn. */
export function readCodexTurn(file: string | Buffer, offset: number): CodexTurnRead | null {
  const bytes = typeof file === 'string' ? readFileSync(file) : file
  const rows = wholeRows(bytes)
  const start = rows.findIndex(({ at, row }) => at >= offset && isStart(row))
  if (start === -1) return null

  const first = rows[start]
  const firstPayload = record(first.row.payload)
  const turnId = textOf(firstPayload.turn_id) || textOf(record(firstPayload.turn_attribution).turn_id)
  if (!turnId) return null

  const next = rows.findIndex(({ at, row }, i) => i > start && at > first.at && isStart(row))
  const end = next === -1 ? rows.length : next
  const segment = rows.slice(start + 1, end)
  const completed = segment.some(({ row }) => isComplete(row))
  const status = completed ? 'complete' : next === -1 ? 'pending' : 'incomplete'
  const meta = record(rows.find(({ row }) => row.type === 'session_meta')?.row.payload)
  const cwd = textOf(meta.cwd)
  const turns = turnsOf(segment.filter(({ row }) => !isComplete(row)).map(({ row }) => row), cwd)
  const person = turns.find(turn => turn.role === 'person')?.text ?? null
  const reply = status === 'complete' ? turns.filter(turn => turn.role === 'agent' && turn.text.trim()).at(-1)?.text ?? '' : ''
  const previous = rolloutTurns(rows.slice(0, start).map(({ at, end }) => bytes.toString('utf8', at, end)), cwd)
  const prompts = previous.filter(turn => turn.turns.some(message => message.role === 'person')).length
  const startedAt = typeof first.row.timestamp === 'string' ? Date.parse(first.row.timestamp) : NaN
  const exchange: Exchange = {
    person,
    trigger: person === null ? 'codex' : null,
    activity: turns.flatMap(turn => turn.role === 'agent' ? turn.activity : []),
    reply,
    turn: prompts + (person === null ? 0 : 1),
    ...(Number.isFinite(startedAt) && { startedAt }),
    press: null,
    screen: '',
  }
  const nextOffset = status === 'pending' ? offset : next === -1 ? (rows.at(-1)?.end ?? offset) : rows[next].at

  return { status, turnId, exchange, nextOffset }
}

/** A newly bound resume starts at its current turn, leaving older rollout turns untouched. */
export function codexResumeStart(bytes: Buffer, currentTurnId: string | undefined): { offset: number; turn: number } {
  let offset = 0
  let turn = 0
  for (;;) {
    const read = readCodexTurn(bytes, offset)
    if (!read) break
    if (read.turnId === currentTurnId) return { offset, turn: Math.max(0, read.exchange.turn - 1) }
    turn = read.exchange.turn
    if (read.nextOffset <= offset) break
    offset = read.nextOffset
  }
  return { offset: bytes.lastIndexOf(10) + 1, turn }
}

/** The current rollout turn number, for a tool call when the prompt hook has not run. */
export function codexToolTurn(bytes: Buffer, offset: number, turnId: string | undefined): number | null {
  const read = readCodexTurn(bytes, offset)
  return read && (!turnId || read.turnId === turnId) ? read.exchange.turn : null
}

/** The first new person's prompt, optionally containing `contains`, and the byte where its turn starts. */
export function codexPromptAfter(bytes: Buffer, offset: number, contains?: string): { uuid: string; text: string; at: number } | null {
  for (let at = offset;;) {
    const turn = readCodexTurn(bytes, at)
    if (!turn) return null
    if (turn.exchange.person !== null && (contains === undefined || turn.exchange.person.replace(/\s+/g, ' ').includes(contains))) {
      // readCodexTurn's turn starts at its first task_started row at or after `at`.
      const start = wholeRows(bytes).find(row => row.at >= at && isStart(row.row))?.at ?? at
      return { uuid: turn.turnId, text: turn.exchange.person, at: start }
    }
    if (turn.status === 'pending' || turn.nextOffset <= at) return null
    at = turn.nextOffset
  }
}
