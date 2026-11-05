// The plugin's worker. Orca transpiles this file when it loads: no build step.
// It tags each Claude Code launch, feeds the turn tracker from status changes, answers the panel's requests
// (src/protocol.ts) and runs presses (src/presses.ts).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { OrcaWorkerApi } from 'orca/worker'

import { tagLaunch } from './launch'
import { runInboxModel } from './model'
import { createPresses, drawnToken, labelledRows, type PressInput, type TerminalStatus } from './presses'
import type { InboxSection, InboxView } from './protocol'
import { wholeLinesEnd } from './transcript'
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
}

const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

type Workspace = { id: string; path: string }
type Agent = { terminalId: string | null; title: string | null; state: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createWorker(orca: OrcaWorkerApi, deps: WorkerDeps): void {
  const log = (m: string) => orca.log(m)

  /** Workspace id to folder, from workspace.list. Read again when an id is missing. */
  let workspaces = new Map<string, string>()
  async function listWorkspaces(): Promise<Map<string, string>> {
    const { workspaces: list } = (await orca.host.call('workspace.list', {})) as { workspaces: Workspace[] }
    workspaces = new Map(list.map(w => [w.id, w.path]))
    return workspaces
  }

  async function pathOf(sessionId: string, workspaceId?: string): Promise<string | null> {
    const ws = workspaceId ?? Object.values(tracker.state().terminals).find(t => t.sessionId === sessionId)?.workspaceId
    if (!ws) return null
    const dir = workspaces.get(ws) ?? (await listWorkspaces()).get(ws)
    return dir ? transcriptPath(deps.home, dir, sessionId) : null
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

  orca.hooks.on('agent.launch.before', async (event, next) => {
    if (!event.terminalId || !event.workspaceId) return undefined
    const tagged = tagLaunch(event.agent, event.command)
    if (!tagged.session) return undefined
    const { id, kind } = tagged.session
    try {
      await ready
      // A resumed session starts at its transcript's end, so the turns it had before are never read again.
      let offset = 0
      if (kind === 'resume' && !tracker.state().sessions[id]) {
        const path = await pathOf(id, event.workspaceId)
        const bytes = path ? await deps.readFile(path) : null
        offset = bytes ? wholeLinesEnd(bytes) : 0
      }
      await tracker.track(event.terminalId, id, { workspaceId: event.workspaceId, offset })
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
    void tracker.done(terminalId).catch(e => log(`done: ${message(e)}`))
  })

  orca.panels.handle('inbox.view', async (): Promise<InboxView> => {
    await ready
    const { agents } = (await orca.host.call('agents.list', {})) as { agents: Agent[] }
    const state = tracker.state()
    const sections: InboxSection[] = []
    let untracked = 0
    let unread = 0
    for (const agent of agents) {
      const sessionId = agent.terminalId ? state.terminals[agent.terminalId]?.sessionId : undefined
      const s = sessionId ? state.sessions[sessionId] : undefined
      if (!agent.terminalId || !sessionId || !s) {
        untracked += 1
        continue
      }
      // agents.list gives the combined state: `done` there means the main agent is done too.
      if (!statuses.has(agent.terminalId) && STATES.includes(agent.state)) statuses.set(agent.terminalId, agent.state as TerminalStatus)
      unread += s.unread
      sections.push({ terminalId: agent.terminalId, sessionId, title: agent.title ?? 'Claude Code', drawn: drawnToken(s), lastActivity: s.touchedAt, ...labelledRows(s) })
    }
    sections.sort((a, b) => b.lastActivity - a.lastActivity)
    return { sections, untracked, unread }
  })

  orca.panels.handle('inbox.press', async (input: PressInput) => {
    await ready
    return presses.press(input)
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  createWorker(orca, {
    clock: realClock,
    home: homedir(),
    model: (prompt, source) => runInboxModel(prompt, { source }),
    readFile: readOrNull,
  })
}
