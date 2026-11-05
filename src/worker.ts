// The plugin's worker. Orca transpiles this file when it loads: no build step.
// It tags each Claude Code launch, feeds the turn tracker from status changes, answers the panel's requests
// (src/protocol.ts), runs presses (src/presses.ts) and answers the agent's tools and prompt hook (src/socket.ts).
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import type { Server } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OrcaWorkerApi } from 'orca/worker'

import { parsePlan, planNote, planPath, type PlanView } from './core/plan'
import { tagLaunch, tokenize } from './launch'
import { runInboxModel } from './model'
import { createPresses, drawnToken, labelledRows, type PressInput, type TerminalStatus } from './presses'
import type { CopyOutcome, InboxSection, InboxView, OtherAgent } from './protocol'
import { binPaths, createAnswerer, listen, socketPath } from './socket'
import { cwdOf, promptsBefore, wholeLinesEnd } from './transcript'
import { createTracker, type Clock, type TrackerDeps } from './turns'

const STATES = ['working', 'blocked', 'waiting', 'done']

export type WorkerDeps = {
  clock: Clock
  home: string
  model: TrackerDeps['model']
  /** A file's bytes, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>
  /** The names of the folders in a folder; none when it does not exist. */
  listDirs(path: string): Promise<string[]>
  /** The socket the agent's tools and prompt hook reach, and their scripts. Null: no socket, and launches get no tools. */
  tools: { socketPath: string; mcpServer: string; promptHook: string } | null
  /** Writes the text to the system clipboard; throws when it cannot. Orca gives a panel no clipboard. */
  copy(text: string): Promise<void>
}

type PlanRead = { plan: PlanView | null; error: string | null }

const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** `pbcopy` on macOS. Elsewhere there is no clipboard command, so the panel shows the text to select. */
function copyToClipboard(text: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('no clipboard command on this system'))
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`))))
    child.stdin.end(text)
  })
}

/** `agent` is Orca's name for the agent, such as `claude` or `codex`; an older Orca may leave it out. */
type Agent = { terminalId: string | null; title: string | null; state: string; agent?: string }

/** Version 1 tracks Claude Code only (spec step 5). An agent with no name counts as Claude: it may be one. */
const isOther = (agent: Agent) => agent.agent !== undefined && agent.agent !== 'claude'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How long a launch waits for its tracking before Orca starts it anyway. The tracking goes on. */
const TRACK_WAIT_MS = 1000

/**
 * Why `tagLaunch` left a launch untagged, for the launch log. It reads the command as `tagLaunch` does and never
 * changes it. The log never holds the command, which can hold a prompt.
 */
function untaggedReason(agent: string, command: string): string {
  if (agent !== 'claude') return 'not-claude'
  const words = tokenize(command)?.map(t => t.text)
  if (!words) return 'unparseable'
  const p = words.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  if (p < 0 || words[p].slice(words[p].lastIndexOf('/') + 1) !== 'claude') return 'not-claude'
  const end = words.indexOf('--', p)
  const args = words.slice(p + 1, end < 0 ? undefined : end).map(w => w.split('=')[0])
  if (args.some(a => a === '--continue' || a === '-c')) return 'continue'
  if (args.includes('--fork-session')) return 'fork'
  if (args.some(a => a === '--resume' || a === '-r')) return 'resume-name'
  return 'unparseable'
}

export function createWorker(orca: OrcaWorkerApi, deps: WorkerDeps): { close(): Promise<void> } {
  const log = (m: string) => orca.log(m)

  // Both are registered first, before any other work, so a launch or a status while the state loads still reaches
  // them. Each waits for `ready` inside.
  orca.hooks.on('agent.launch.before', async (event, next) => {
    const line = (tagged: string, tools: boolean, reason: string) =>
      log(`launch: agent=${event.agent} terminal=${event.terminalId ? 'yes' : 'no'} workspaceKind=${event.workspaceKind ?? 'none'} tagged=${tagged} tools=${tools ? 'yes' : 'no'} reason=${reason}`)
    const terminalId = event.terminalId
    if (!terminalId) return line('no', false, 'no-terminal')
    let tagged: ReturnType<typeof tagLaunch>
    try {
      tagged = tagLaunch(event.agent, event.command, undefined, deps.tools ?? undefined)
    } catch (e) {
      return line('no', false, `error:${message(e)}`)
    }
    if (!tagged.session) return line('no', false, untaggedReason(event.agent, event.command))
    const { id, kind } = tagged.session
    line(kind, tagged.tools, '-')
    const tracking = (async () => {
      await ready
      // A resumed session starts at its transcript's end, so the turns it had before are never read again.
      // Its turn count starts at the prompts before that end, so a prompt-start raises the turn the transcript gives.
      let offset = 0
      let turn = 0
      const found = kind === 'resume' && !tracker.state().sessions[id] ? await find(id) : null
      if (found) {
        offset = wholeLinesEnd(found.bytes)
        turn = promptsBefore(found.bytes, offset)
      }
      await tracker.track(terminalId, id, { offset, turn, tools: tagged.tools })
      if (found) await learn(id, { transcript: found.path, cwd: cwdOf(found.bytes) })
    })().catch(e => log(`launch: could not track ${terminalId}: ${message(e)}`))
    // A slow state load must not hold the launch until Orca gives up on the hook and drops the tag.
    await Promise.race([tracking, deps.clock.sleep(TRACK_WAIT_MS)])
    return tagged.command === event.command ? undefined : next({ ...event, command: tagged.command })
  })

  orca.events.on('agent.status.changed', async event => {
    // Spec step 2: the main agent's state, not the combined one; an older Orca has only `state`.
    const terminalId = event.terminalId
    if (!terminalId) return
    const state = (event.mainAgent?.state ?? event.state) as TerminalStatus
    statuses.set(terminalId, state)
    if (state !== 'done') return
    await ready
    const sessionId = tracker.state().terminals[terminalId]?.sessionId
    if (sessionId) void readPlan(sessionId).catch(e => log(`plan: ${message(e)}`))
    void tracker.done(terminalId).catch(e => log(`done: ${message(e)}`))
  })

  log('start: hooks registered')

  const projects = join(deps.home, '.claude', 'projects')

  /**
   * Finds a session's transcript by its id alone: `~/.claude/projects/<any folder>/<session id>.jsonl`. The launch's
   * workspace id does not give the folder (docs/live-check.md), and Claude Code's folder name is its own.
   */
  async function find(sessionId: string): Promise<{ path: string; bytes: Buffer } | null> {
    for (const dir of await deps.listDirs(projects)) {
      const path = join(projects, dir, `${sessionId}.jsonl`)
      const bytes = await deps.readFile(path)
      if (bytes) return { path, bytes }
    }
    return null
  }

  /** Saves the transcript path and the folder once known. The first value found stays. */
  async function learn(sessionId: string, found: { transcript?: string; cwd?: string | null }): Promise<void> {
    const s = tracker.state().sessions[sessionId]
    if (!s || ((s.transcript || !found.transcript) && (s.cwd || !found.cwd))) return
    await tracker.edit(sessionId, cur => ({ ...cur, transcript: cur.transcript ?? found.transcript ?? null, cwd: cur.cwd ?? found.cwd ?? null }))
  }

  /** The session's whole transcript, or null before Claude Code writes it: the next read looks again. */
  async function read(sessionId: string): Promise<Buffer | null> {
    const s = tracker.state().sessions[sessionId]
    if (!s) return null
    const hit = s.transcript ? { path: s.transcript, bytes: await deps.readFile(s.transcript) } : await find(sessionId)
    if (!hit?.bytes) return null
    await learn(sessionId, { transcript: hit.path, cwd: s.cwd ? undefined : cwdOf(hit.bytes) })
    return hit.bytes
  }

  /** The session's folder: its saved `cwd`, else the first `cwd` its transcript gives. */
  async function dirOf(sessionId: string): Promise<string | null> {
    const known = tracker.state().sessions[sessionId]?.cwd
    if (known) return known
    await read(sessionId)
    return tracker.state().sessions[sessionId]?.cwd ?? null
  }

  /** Each session's plan, as last read (spec "The session plan", step 2). The plugin only reads the file. */
  const plans = new Map<string, PlanRead>()

  /**
   * Reads the session's plan file, and tells the panel when the plan changed. Null when the folder is not known.
   * A file that cannot be read, or has text but no step, gives its path as the error, as `readPlan` in the inbox's
   * `hooks/register.tsx` does. A missing or empty file is no plan and no error.
   */
  async function readPlan(sessionId: string): Promise<({ path: string } & PlanRead) | null> {
    const dir = await dirOf(sessionId)
    if (!dir) return null
    const path = planPath(dir, sessionId)
    let read: PlanRead = { plan: null, error: null }
    try {
      const text = (await deps.readFile(path))?.toString('utf8') ?? null
      const plan = text === null ? null : parsePlan(text)
      read = { plan, error: plan === null && text !== null && text.trim() !== '' ? path : null }
    } catch (e) {
      log(`plan: could not read ${sessionId}: ${message(e)}`)
      read = { plan: null, error: path }
    }
    const before = plans.get(sessionId)
    plans.set(sessionId, read)
    if (before !== undefined && JSON.stringify(before) !== JSON.stringify(read)) orca.panels.post('inbox.changed', {})
    return { path, ...read }
  }

  /** The newest main-agent status per terminal, for the send check. Lost on a restart; agents.list fills it again. */
  const statuses = new Map<string, TerminalStatus>()

  const tracker = createTracker({
    storage: orca.storage,
    clock: deps.clock,
    read,
    model: deps.model,
    log,
    changed: () => orca.panels.post('inbox.changed', {}),
  })
  const presses = createPresses({
    state: () => tracker.state(),
    edit: (id, change) => tracker.edit(id, change),
    status: id => statuses.get(id),
    send: async (terminalId, text) => {
      const { accepted } = (await orca.host.call('terminal.sendText', { terminalId, text, enter: true })) as { accepted: boolean }
      return accepted
    },
    read,
    clock: deps.clock,
    log,
  })

  const ready = tracker
    .start()
    .then(() => tracker.prune())
    .catch(e => log(`start: ${message(e)}`))

  const answer = createAnswerer({
    state: () => tracker.state(),
    edit: (id, change) => tracker.edit(id, change),
    now: () => deps.clock.now(),
    planNote: async id => {
      const read = await readPlan(id)
      return read ? planNote(read.path, read.plan) : null
    },
  })
  const server: Promise<Server | null> = deps.tools
    ? listen(
        deps.tools.socketPath,
        async request => {
          await ready
          return answer(request)
        },
        log,
      ).catch(e => {
        log(`socket: could not listen: ${message(e)}`)
        return null
      })
    : Promise.resolve(null)

  orca.panels.handle('inbox.view', async (): Promise<InboxView> => {
    await ready
    const { agents } = (await orca.host.call('agents.list', {})) as { agents: Agent[] }
    const state = tracker.state()
    const sections: InboxSection[] = []
    const others: OtherAgent[] = []
    let untracked = 0
    let unread = 0
    for (const [n, agent] of agents.entries()) {
      if (isOther(agent)) {
        const name = agent.agent ?? ''
        others.push({ key: agent.terminalId ?? `agent-${n}`, title: agent.title ?? name.charAt(0).toUpperCase() + name.slice(1) })
        continue
      }
      const sessionId = agent.terminalId ? state.terminals[agent.terminalId]?.sessionId : undefined
      const s = sessionId ? state.sessions[sessionId] : undefined
      if (!agent.terminalId || !sessionId || !s) {
        untracked += 1
        continue
      }
      // agents.list gives the combined state: `done` there means the main agent is done too.
      if (!statuses.has(agent.terminalId) && STATES.includes(agent.state)) statuses.set(agent.terminalId, agent.state as TerminalStatus)
      unread += s.unread
      const { plan, error: planError } = plans.get(sessionId) ?? (await readPlan(sessionId)) ?? { plan: null, error: null }
      sections.push({
        terminalId: agent.terminalId,
        sessionId,
        title: agent.title ?? 'Claude Code',
        drawn: drawnToken(s),
        lastActivity: s.touchedAt,
        plan,
        planError,
        tools: s.tools,
        ...labelledRows(s, deps.clock.now()),
      })
    }
    sections.sort((a, b) => b.lastActivity - a.lastActivity)
    return { sections, others, untracked, unread }
  })

  orca.panels.handle('inbox.copy', async ({ text }: { text: string }): Promise<CopyOutcome> => {
    try {
      await deps.copy(text)
      return { ok: true }
    } catch (e) {
      log(`copy: ${message(e)}`)
      return { ok: false, error: message(e) }
    }
  })

  orca.panels.handle('inbox.press', async (input: PressInput) => {
    await ready
    return presses.press(input)
  })

  return {
    /** Closes the socket and removes its file. */
    async close(): Promise<void> {
      const s = await server
      if (!s) return
      await new Promise<void>(resolve => s.close(() => resolve()))
    },
  }
}

let worker: { close(): Promise<void> } | null = null

export default function activate(orca: OrcaWorkerApi): void {
  worker = createWorker(orca, {
    clock: realClock,
    home: homedir(),
    model: (prompt, source) => runInboxModel(prompt, { source }),
    readFile: readOrNull,
    listDirs,
    copy: copyToClipboard,
    tools: { socketPath: socketPath(), ...binPaths() },
  })
}

export async function deactivate(): Promise<void> {
  await worker?.close()
}
