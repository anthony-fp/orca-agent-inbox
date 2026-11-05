// The plugin's worker. Orca transpiles this file when it loads: no build step.
// It tags each Claude Code launch, feeds the turn tracker from status changes, answers the panel's requests
// (src/protocol.ts), runs presses (src/presses.ts) and answers the agent's tools and prompt hook (src/socket.ts).
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OrcaWorkerApi } from 'orca/worker'

import { parsePlan, planNote, planPath, type PlanView } from './core/plan'
import { tagLaunch } from './launch'
import { runInboxModel } from './model'
import { createPresses, drawnToken, labelledRows, type PressInput, type TerminalStatus } from './presses'
import type { CopyOutcome, InboxSection, InboxView, OtherAgent } from './protocol'
import { binPaths, createAnswerer, listen, socketPath } from './socket'
import { promptsBefore, wholeLinesEnd } from './transcript'
import { createTracker, type Clock, type TrackerDeps } from './turns'

const STATES = ['working', 'blocked', 'waiting', 'done']

/** Claude Code's folder name for a project: each character that is not a letter or digit becomes `-`. */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Where Claude Code writes a session's transcript for a workspace folder. */
export function transcriptPath(home: string, workspacePath: string, sessionId: string): string {
  return join(home, '.claude', 'projects', projectSlug(workspacePath), `${sessionId}.jsonl`)
}

export type WorkerDeps = {
  clock: Clock
  home: string
  model: TrackerDeps['model']
  /** A file's bytes, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>
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

type Workspace = { id: string; path: string }
/** `agent` is Orca's name for the agent, such as `claude` or `codex`; an older Orca may leave it out. */
type Agent = { terminalId: string | null; title: string | null; state: string; agent?: string }

/** Version 1 tracks Claude Code only (spec step 5). An agent with no name counts as Claude: it may be one. */
const isOther = (agent: Agent) => agent.agent !== undefined && agent.agent !== 'claude'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createWorker(orca: OrcaWorkerApi, deps: WorkerDeps): { close(): Promise<void> } {
  const log = (m: string) => orca.log(m)

  /** Workspace id to folder, from workspace.list. Read again when an id is missing. */
  let workspaces = new Map<string, string>()
  async function listWorkspaces(): Promise<Map<string, string>> {
    const { workspaces: list } = (await orca.host.call('workspace.list', {})) as { workspaces: Workspace[] }
    workspaces = new Map(list.map(w => [w.id, w.path]))
    return workspaces
  }

  /** The session's workspace folder. */
  async function dirOf(sessionId: string, workspaceId?: string): Promise<string | null> {
    const ws = workspaceId ?? Object.values(tracker.state().terminals).find(t => t.sessionId === sessionId)?.workspaceId
    if (!ws) return null
    return workspaces.get(ws) ?? (await listWorkspaces()).get(ws) ?? null
  }

  async function pathOf(sessionId: string, workspaceId?: string): Promise<string | null> {
    const dir = await dirOf(sessionId, workspaceId)
    return dir ? transcriptPath(deps.home, dir, sessionId) : null
  }

  /** Each session's plan, as last read (spec "The session plan", step 2). The plugin only reads the file. */
  const plans = new Map<string, PlanRead>()

  /**
   * Reads the session's plan file, and tells the panel when the plan changed. Null when the workspace is not known.
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

  async function read(sessionId: string): Promise<Buffer | null> {
    const path = await pathOf(sessionId)
    return path ? deps.readFile(path) : null
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

  async function prune(): Promise<void> {
    let live: Set<string> | null = null
    try {
      live = new Set((await listWorkspaces()).keys())
    } catch (e) {
      log(`prune: workspace.list failed: ${message(e)}`)
    }
    await tracker.prune(live)
  }

  const ready = tracker
    .start()
    .then(prune)
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

  orca.hooks.on('agent.launch.before', async (event, next) => {
    if (!event.terminalId || !event.workspaceId) return undefined
    const tagged = tagLaunch(event.agent, event.command, undefined, deps.tools ?? undefined)
    if (!tagged.session) return undefined
    const { id, kind } = tagged.session
    try {
      await ready
      // A resumed session starts at its transcript's end, so the turns it had before are never read again.
      // Its turn count starts at the prompts before that end, so a prompt-start raises the turn the transcript gives.
      let offset = 0
      let turn = 0
      if (kind === 'resume' && !tracker.state().sessions[id]) {
        const path = await pathOf(id, event.workspaceId)
        const bytes = path ? await deps.readFile(path) : null
        offset = bytes ? wholeLinesEnd(bytes) : 0
        turn = bytes ? promptsBefore(bytes, offset) : 0
      }
      await tracker.track(event.terminalId, id, { workspaceId: event.workspaceId, offset, turn, tools: tagged.tools })
    } catch (e) {
      log(`launch: could not track ${event.terminalId}: ${message(e)}`)
    }
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
    copy: copyToClipboard,
    tools: { socketPath: socketPath(), ...binPaths() },
  })
}

export async function deactivate(): Promise<void> {
  await worker?.close()
}
