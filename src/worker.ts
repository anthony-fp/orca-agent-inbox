// The plugin's worker. Orca transpiles this file when it loads: no build step.
// It tags each Claude Code launch, feeds the turn tracker from status changes, answers the panel's requests
// (src/protocol.ts), runs presses (src/presses.ts) and answers the agent's tools and prompt hook (src/socket.ts).
import { readFile, readdir } from 'node:fs/promises'
import type { Server } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { OrcaWorkerApi } from 'orca/worker'

import { copyToClipboard } from './clipboard'
import { launchOf, runOrca, type OrcaReply } from './orca-cli'
import { parsePlan, planGoal, planNote, planPath, type PlanView } from './core/plan'
import { codexResumeStart, codexToolTurn, readCodexTurn, rolloutFor } from './core/codex-transcript'
import { tagLaunch, tokenize } from './launch'
import { runInboxModel } from './model'
import { createPresses, drawnToken, handoffText, labelledRows, rowLabel, setLabel, type PressInput, type TerminalStatus } from './presses'
import type { CopyOutcome, HandoffOutcome, InboxSection, InboxView, OpenOutcome, OtherAgent, SnoozeOutcome } from './protocol'
import { binPaths, createAnswerer, listen, socketPath, stableBinPaths } from './socket'
import { emptySession, type Handoff, type PressLabel } from './state'
import { cwdOf, promptsBefore, wholeLinesEnd } from './transcript'
import { createTracker, type Clock, type TrackerDeps } from './turns'

const STATES = ['working', 'blocked', 'waiting', 'done']
/** How often the worker lists live terminals for the retention rule (src/turns.ts evictable). */
const LIST_MS = 60_000

export type WorkerDeps = {
  clock: Clock
  home: string
  model: TrackerDeps['model']
  /** A file's bytes, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>
  /** The names of the folders in a folder; none when it does not exist. */
  listDirs(path: string): Promise<string[]>
  /** Codex's rollout lookup, replaceable for tests that use hand-written files. */
  codexRollout?: typeof rolloutFor
  /** The socket the agent's tools and prompt hook reach, and their scripts. Null: no socket, and launches get no tools. */
  tools: { socketPath: string; mcpServer: string; promptHook: string } | null
  /** Writes the text to the system clipboard; throws when it cannot. Orca gives a panel no clipboard. */
  copy(text: string): Promise<void>
  /** Runs `orca <args> --json` (src/orca-cli.ts). It never throws. */
  orca(args: string[]): Promise<OrcaReply>
}

type PlanRead = { plan: PlanView | null; error: string | null; goal: string | null }

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

/** `agent` is Orca's name for the agent, such as `claude` or `codex`; an older Orca may leave it out. */
type Agent = { terminalId: string | null; title: string | null; state: string; agent?: string; mainAgent?: { state?: string } }

/** An agent with no name counts as Claude: older Orca may leave it out. */
const isOther = (agent: Agent) => agent.agent !== undefined && agent.agent !== 'claude' && agent.agent !== 'codex'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How long a launch waits for its tracking before Orca starts it anyway. The tracking goes on. */
const TRACK_WAIT_MS = 1000

/** How long the panel's reload after a status change waits, so a burst of changes reloads it once. */
const RELOAD_MS = 250

/** The storage key of the snoozes, apart from the state: `"<sessionId>:<rowId>"` to the time (ms) each one ends. */
const SNOOZES = 'snoozes'
type Snoozes = Record<string, number>

/**
 * Why `tagLaunch` left a launch untagged, for the launch log. It reads the command as `tagLaunch` does and never
 * changes it. The log never holds the command, which can hold a prompt.
 */
/** Whether `path` is `folder` or inside it, by whole path parts: `/a/b` holds `/a/b/c`, not `/a/bc`. */
function holds(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
}

/** A worktree name from a row's text: lower case words joined by `-`, at most 40 characters. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'handoff'
}

/** `workspace.list` gives no local marker: Orca's own code names this machine `local`, and a folder may give null. */
const isLocal = (hostId: string | null) => hostId === null || hostId === 'local'

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

export function createWorker(orca: OrcaWorkerApi, deps: WorkerDeps): { listening: Promise<void>; close(): Promise<void> } {
  const log = (m: string) => orca.log(m)
  const launchTools = deps.tools
    ? stableBinPaths(deps.tools.socketPath, dirname(deps.tools.mcpServer)).then(paths => ({ ...deps.tools!, ...paths }))
      .catch(e => { log(`scripts: could not copy: ${message(e)}`); return deps.tools })
    : Promise.resolve(null)
  const codexLaunches = new Map<string, { kind: 'tracked' | 'skipped'; at: number }>()
  let codexLaunchWithoutTerminal = false
  const launchGenerations = new Map<string, number>()

  // Both are registered first, before any other work, so a launch or a status while the state loads still reaches
  // them. Each waits for `ready` inside.
  orca.hooks.on('agent.launch.before', async (event, next) => {
    const line = (tagged: string, tools: boolean, reason: string) =>
      log(`launch: agent=${event.agent} terminal=${event.terminalId ? 'yes' : 'no'} workspaceKind=${event.workspaceKind ?? 'none'} tagged=${tagged} tools=${tools ? 'yes' : 'no'} reason=${reason}`)
    // A launch with no terminal id is tagged too, and saved with no terminal: its prompt hook binds the terminal.
    const terminalId = event.terminalId ?? null
    const launchedAt = deps.clock.now()
    // Each launch in a terminal is a new generation: an older launch still reading its transcript must not bind over it.
    const generation = terminalId ? (launchGenerations.get(terminalId) ?? 0) + 1 : 0
    if (terminalId) launchGenerations.set(terminalId, generation)
    const oldPaneKey = terminalId ? [...paneTerminals].find(([, terminal]) => terminal === terminalId)?.[0] : undefined
    if (terminalId) {
      codexLaunches.set(terminalId, { kind: 'skipped', at: launchedAt })
      for (const [key, terminal] of paneTerminals) if (terminal === terminalId) paneTerminals.delete(key)
    }
    const clearing = terminalId ? ready.then(() => tracker.clearPane(terminalId, launchedAt, oldPaneKey)).catch(e => log(`launch: could not clear ${terminalId}: ${message(e)}`)) : Promise.resolve()
    const waitForClear = () => Promise.race([clearing, deps.clock.sleep(TRACK_WAIT_MS)])
    if (event.agent === 'codex' && !terminalId) codexLaunchWithoutTerminal = true
    let tagged: ReturnType<typeof tagLaunch>
    try {
      tagged = tagLaunch(event.agent, event.command, undefined, (await launchTools) ?? undefined)
    } catch (e) {
      await waitForClear()
      return line('no', false, `error:${message(e)}`)
    }
    if (!tagged.session) {
      await waitForClear()
      return line('no', false, untaggedReason(event.agent, event.command))
    }
    if (tagged.session.kind === 'codex') {
      if (terminalId) codexLaunches.set(terminalId, { kind: 'tracked', at: launchedAt })
      await waitForClear()
      line('codex', tagged.tools, '-')
      return next({ ...event, command: tagged.command })
    }
    const { id, kind } = tagged.session
    line(kind, tagged.tools, '-')
    const tracking = (async () => {
      await ready
      await clearing
      // A resumed session starts at its transcript's end, so the turns it had before are never read again.
      // Its turn count starts at the prompts before that end, so a prompt-start raises the turn the transcript gives.
      let offset = 0
      let turn = 0
      const found = kind === 'resume' && !tracker.state().sessions[id] ? await find(id) : null
      if (found) {
        offset = wholeLinesEnd(found.bytes)
        turn = promptsBefore(found.bytes, offset)
      }
      if (terminalId && launchGenerations.get(terminalId) !== generation) return
      await tracker.track(terminalId, id, { offset, turn, tools: tagged.tools })
      if (found) await learn(id, { transcript: found.path, cwd: cwdOf(found.bytes) })
    })().catch(e => log(`launch: could not track ${terminalId}: ${message(e)}`))
    // A slow state load must not hold the launch until Orca gives up on the hook and drops the tag.
    await Promise.race([tracking, deps.clock.sleep(TRACK_WAIT_MS)])
    return tagged.command === event.command ? undefined : next({ ...event, command: tagged.command })
  })

  /**
   * The panel reloads after every status change, at most once per RELOAD_MS: a new agent, a status or an untracked
   * agent saves nothing, so no save tells the panel.
   */
  let reloading = false
  function reloadSoon(): void {
    if (reloading) return
    reloading = true
    void deps.clock.sleep(RELOAD_MS).then(() => {
      reloading = false
      orca.panels.post('inbox.changed', {})
    })
  }

  orca.events.on('agent.status.changed', async event => {
    reloadSoon()
    // Spec step 2: the main agent's state, not the combined one; an older Orca has only `state`.
    const terminalId = event.terminalId
    if (!terminalId) return
    if (event.paneKey && codexLaunches.get(terminalId)?.kind !== 'skipped') paneTerminals.set(event.paneKey, terminalId)
    const state = (event.mainAgent?.state ?? event.state) as TerminalStatus
    statuses.set(terminalId, state)
    await ready
    if (event.paneKey && codexLaunches.get(terminalId)?.kind === 'tracked')
      await tracker.markPaneLaunch(event.paneKey, codexLaunches.get(terminalId)!.at)
    if (event.paneKey && codexLaunches.get(terminalId)?.kind !== 'skipped') {
      for (const pending of tracker.state().pendingCodex?.[event.paneKey] ?? [])
        await bindCodex(event.paneKey, pending.threadId, pending.codexHome, 'notify', pending.turnId)
    }
    const pane = event.paneKey && codexLaunches.get(terminalId)?.kind !== 'skipped' ? tracker.state().panes[event.paneKey] : undefined
    if (pane && (tracker.state().terminals[terminalId]?.sessionId !== pane.threadId || tracker.state().terminals[terminalId]?.paneKey !== event.paneKey))
      await tracker.track(terminalId, pane.threadId, { pane: { key: event.paneKey, codexHome: pane.codexHome, promptHookSeen: pane.promptHookSeen } })
    if (pane && state !== 'done') await tracker.codexStatus(pane.threadId, false)
    if (state !== 'done') return
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
    if (s.agent === 'codex') return s.transcript ? deps.readFile(s.transcript) : null
    const hit = s.transcript ? { path: s.transcript, bytes: await deps.readFile(s.transcript) } : await find(sessionId)
    if (!hit?.bytes) return null
    // A failed save of what was learned still returns the bytes: the next read learns it again.
    await learn(sessionId, { transcript: hit.path, cwd: s.cwd ? undefined : cwdOf(hit.bytes) })
      .catch(e => log(`read: could not save ${sessionId}: ${message(e)}`))
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
    let read: PlanRead = { plan: null, error: null, goal: null }
    try {
      const text = (await deps.readFile(path))?.toString('utf8') ?? null
      const plan = text === null ? null : parsePlan(text)
      read = { plan, error: plan === null && text !== null && text.trim() !== '' ? path : null, goal: text === null ? null : planGoal(text) }
    } catch (e) {
      log(`plan: could not read ${sessionId}: ${message(e)}`)
      read = { plan: null, error: path, goal: null }
    }
    const before = plans.get(sessionId)
    plans.set(sessionId, read)
    if (before !== undefined && JSON.stringify(before) !== JSON.stringify(read)) orca.panels.post('inbox.changed', {})
    return { path, ...read }
  }

  /** The newest main-agent status per terminal, for the send check. Lost on a restart; agents.list fills it again. */
  const statuses = new Map<string, TerminalStatus>()
  const paneTerminals = new Map<string, string>()

  /**
   * The handles of live terminals in every workspace, from `orca terminal list` with no `--worktree`. Null until the
   * first list, and after a failed or truncated one: then nothing is evicted.
   */
  let live: Set<string> | null = null
  async function listTerminals(): Promise<void> {
    const reply = await deps.orca(['terminal', 'list'])
    const terminals = reply.kind === 'ok' && reply.result?.truncated === false ? reply.result.terminals : null
    live = Array.isArray(terminals) ? new Set(terminals.map((t: { handle?: unknown }) => String(t.handle))) : null
    if (!live) log(`terminals: no list: ${reply.kind === 'ok' ? 'truncated' : reply.error}`)
  }
  const listing = setInterval(() => void listTerminals(), LIST_MS)
  listing.unref?.()

  const tracker = createTracker({
    storage: orca.storage,
    live: () => live,
    clock: deps.clock,
    read,
    codexTurn: async (sessionId, offset) => {
      const bytes = await read(sessionId)
      return bytes ? readCodexTurn(bytes, offset) : null
    },
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
    .start(listTerminals)
    .catch(e => log(`start: ${message(e)}`))

  /**
   * The snoozes that have not ended, after `change` when given. Ended ones are dropped from storage as they are read.
   * One read or change at a time, so two snoozes at once both save.
   */
  let snoozing: Promise<unknown> = Promise.resolve()
  function snoozes(change?: (live: Snoozes) => Snoozes): Promise<Snoozes> {
    const run = snoozing.then(async () => {
      const raw = await orca.storage.get(SNOOZES)
      const saved = Object.entries(raw !== null && typeof raw === 'object' ? raw : {})
      const now = deps.clock.now()
      const live: Snoozes = Object.fromEntries(saved.filter(([, end]) => typeof end === 'number' && end > now))
      const next = change ? change(live) : live
      if (change || saved.length !== Object.keys(live).length) await orca.storage.set(SNOOZES, next)
      return next
    })
    snoozing = run.catch(() => undefined)
    return run
  }

  /** The first session_meta time, or the timestamp Codex put in the rollout name. */
  async function rolloutStart(path: string): Promise<number | null> {
    const bytes = await deps.readFile(path)
    if (bytes) {
      try {
        const row = JSON.parse(bytes.toString('utf8', 0, bytes.indexOf(10) + 1 || bytes.length))
        const at = row.type === 'session_meta' ? Date.parse(row.timestamp) : NaN
        if (Number.isFinite(at)) return at
      } catch { /* use the rollout name */ }
    }
    const name = /rollout-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(path)
    const at = name ? Date.parse(`${name[1]}T${name[2]}:${name[3]}:${name[4]}Z`) : NaN
    return Number.isFinite(at) ? at : null
  }

  async function bindCodexNow(paneKey: string, threadId: string, codexHome: string, source: 'prompt' | 'tool' | 'notify', turnId?: string): Promise<void> {
    const home = codexHome || tracker.state().panes[paneKey]?.codexHome || ''
    const known = tracker.state().sessions[threadId]
    const rollout = known?.transcript && tracker.state().panes[paneKey]?.threadId === threadId
      ? { path: known.transcript, cwd: known.cwd ?? '' }
      : home ? await (deps.codexRollout ?? rolloutFor)(home, threadId) : null
    const started = rollout ? await rolloutStart(rollout.path) : null
    if (source === 'notify' && rollout && started === null && tracker.state().paneLaunches[paneKey] !== undefined &&
        tracker.state().panes[paneKey]?.threadId !== threadId) return
    if (started !== null && started < (tracker.state().paneLaunches[paneKey] ?? -Infinity)) {
      if (turnId) await tracker.clearStagedCodex(paneKey, threadId, turnId)
      return
    }
    const previous = tracker.state().panes[paneKey]
    // Notify has no thread-source marker; the rollout's session_meta must prove it is the main chat.
    if (source === 'notify' && !rollout) {
      await tracker.stageCodex(paneKey, threadId, home, turnId ?? '')
      return
    }
    if (previous && previous.threadId !== threadId) {
      const boundPath = tracker.state().sessions[previous.threadId]?.transcript ??
        (previous.codexHome ? (await (deps.codexRollout ?? rolloutFor)(previous.codexHome, previous.threadId))?.path : null)
      const older = boundPath ? await rolloutStart(boundPath) : null
      const newer = rollout ? await rolloutStart(rollout.path) : null
      if ((source === 'notify' && (older === null || newer === null)) || (older !== null && newer !== null && newer <= older)) {
        if (newer !== null && older !== null && newer <= older && turnId) await tracker.clearStagedCodex(paneKey, threadId, turnId)
        return
      }
    }
    const needsStart = !known || (known.offset === 0 && known.lastTurnId === null && known.queue.length === 0 && !known.transcript)
    const bytes = (needsStart || source === 'tool') && rollout ? await deps.readFile(rollout.path) : null
    const { offset, turn } = needsStart && bytes ? codexResumeStart(bytes, turnId) : { offset: 0, turn: 0 }
    const currentOffset = known?.queue.at(-1)?.nextOffset ?? known?.offset ?? offset
    const toolTurn = source === 'tool' && bytes ? codexToolTurn(bytes, currentOffset, turnId) : null
    if (tracker.state().panes[paneKey]?.threadId !== previous?.threadId ||
        (started !== null && started < (tracker.state().paneLaunches[paneKey] ?? -Infinity))) return
    const terminalId = paneTerminals.get(paneKey) ??
      Object.entries(tracker.state().terminals).find(([id, t]) => codexLaunches.get(id)?.kind !== 'skipped' && t.sessionId === previous?.threadId)?.[0] ?? null
    await tracker.track(terminalId, threadId, {
      offset, turn,
      pane: { key: paneKey, codexHome: home, promptHookSeen: source === 'prompt' },
    })
    if (rollout || source === 'tool') await tracker.edit(threadId, s => ({
      ...s,
      transcript: rollout?.path ?? s.transcript,
      cwd: s.cwd ?? rollout?.cwd ?? null,
      ...(s.offset === 0 && s.lastTurnId === null && s.queue.length === 0 && offset > 0
        ? { offset, ledger: { ...s.ledger, turn: Math.max(s.ledger.turn, turn) } } : {}),
      activeTurn: source === 'tool' ? Math.max(s.activeTurn, toolTurn ?? turn + 1) : s.activeTurn,
    }))
    for (const pending of tracker.state().pendingCodex?.[paneKey] ?? []) {
      if (pending.threadId !== threadId) continue
      await tracker.codexNotify(threadId, pending.turnId)
      await tracker.clearStagedCodex(paneKey, threadId, pending.turnId)
    }
    tracker.retryCodex(threadId)
  }

  const codexBindings = new Map<string, Promise<void>>()
  function bindCodex(paneKey: string, threadId: string, codexHome: string, source: 'prompt' | 'tool' | 'notify', turnId?: string): Promise<void> {
    const prior = codexBindings.get(paneKey) ?? Promise.resolve()
    const run = prior.catch(() => undefined).then(() => bindCodexNow(paneKey, threadId, codexHome, source, turnId))
    codexBindings.set(paneKey, run)
    void run.then(() => { if (codexBindings.get(paneKey) === run) codexBindings.delete(paneKey) },
      () => { if (codexBindings.get(paneKey) === run) codexBindings.delete(paneKey) })
    return run
  }

  const claudeBindings = new Map<string, Promise<void>>()
  function bindClaude(launchSession: string, sessionId: string, transcript?: string, cwd?: string, terminalId?: string): Promise<void> {
    const state = tracker.state()
    const bound = state.moved?.[launchSession] ?? launchSession
    const key = Object.entries(state.terminals).find(([, t]) => t.sessionId === bound)?.[0] ?? terminalId ?? launchSession
    const prior = claudeBindings.get(key) ?? Promise.resolve()
    const run = prior.catch(() => undefined).then(async () => {
      const state = tracker.state()
      const launch = state.sessions[launchSession]
      if (!launch || launch.agent !== 'claude') return
      const bound = state.moved?.[launchSession] ?? launchSession
      const terminal = Object.entries(state.terminals).find(([, t]) => t.sessionId === bound)?.[0] ??
        (terminalId && /^term_[A-Za-z0-9-]{1,128}$/.test(terminalId) ? terminalId : null)
      if (!terminal) return
      const known = state.sessions[sessionId]
      const bytes = !known && transcript ? await deps.readFile(transcript) : null
      const found = !known && !bytes ? await find(sessionId) : null
      const contents = bytes ?? found?.bytes ?? null
      const offset = contents ? wholeLinesEnd(contents) : 0
      const turn = contents ? promptsBefore(contents, offset) : 0
      await tracker.track(terminal, sessionId, known ? {} : { offset, turn, tools: launch.tools })
      if (!known) await learn(sessionId, { transcript: bytes ? transcript : found?.path ?? transcript, cwd: cwd ?? (contents ? cwdOf(contents) : null) })
      await tracker.move(launchSession, sessionId)
    })
    claudeBindings.set(key, run)
    void run.finally(() => { if (claudeBindings.get(key) === run) claudeBindings.delete(key) }).catch(() => undefined)
    return run
  }

  const answer = createAnswerer({
    state: () => tracker.state(),
    edit: (id, change, opts) => tracker.edit(id, change, opts),
    now: () => deps.clock.now(),
    planNote: async id => {
      const read = await readPlan(id)
      return read ? planNote(read.path, read.plan) : null
    },
    bind: async (terminalId, sessionId, paneKey) => {
      if (!(await tracker.bind(terminalId, sessionId, paneKey))) return
      log('bind: terminal from prompt hook')
      orca.panels.post('inbox.changed', {})
    },
    adopt: async (terminalId, sessionId, transcript, cwd) => {
      const state = tracker.state()
      // track() would move the terminal off its session, so a terminal bound to another known session stays as it is.
      const bound = state.terminals[terminalId]?.sessionId
      if (state.sessions[sessionId] || (bound && state.sessions[bound])) return
      const bytes = transcript ? await deps.readFile(transcript) : null
      const found = bytes ? null : await find(sessionId)
      const contents = bytes ?? found?.bytes ?? null
      const offset = contents ? wholeLinesEnd(contents) : 0
      await tracker.track(terminalId, sessionId, { offset, turn: contents ? promptsBefore(contents, offset) : 0 })
      await learn(sessionId, { transcript: bytes ? transcript : found?.path ?? transcript, cwd: cwd ?? (contents ? cwdOf(contents) : null) })
      log('bind: unknown session from prompt hook')
      orca.panels.post('inbox.changed', {})
    },
    bindCodex,
    bindClaude,
    notifyCodex: async (paneKey, threadId, turnId) => {
      await tracker.codexNotify(threadId, turnId)
    },
  })
  void ready.then(async () => {
    for (const [paneKey, pending] of Object.entries(tracker.state().pendingCodex ?? {}))
      for (const notice of pending) await bindCodex(paneKey, notice.threadId, notice.codexHome, 'notify', notice.turnId)
  }).catch(e => log(`codex: could not retry notify: ${message(e)}`))
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
    const snoozed = await snoozes().catch(e => (log(`snooze: could not read: ${message(e)}`), {} as Snoozes))
    const snoozedIn = (sessionId: string) =>
      Object.fromEntries(Object.entries(snoozed).filter(([key]) => key.startsWith(`${sessionId}:`)).map(([key, end]) => [key.slice(sessionId.length + 1), end]))
    // Orca gives one entry per status, and two statuses can resolve to one terminal: the newest entry comes first and
    // stands for the terminal, so a section and its unread turns count once.
    const seen = new Set<string>()
    for (const [n, agent] of agents.entries()) {
      if (agent.terminalId) {
        if (seen.has(agent.terminalId)) continue
        seen.add(agent.terminalId)
      }
      if (isOther(agent)) {
        const name = agent.agent ?? ''
        others.push({ key: agent.terminalId ?? `agent-${n}`, title: agent.title ?? name.charAt(0).toUpperCase() + name.slice(1), agent: name })
        continue
      }
      const sessionId = agent.terminalId ? state.terminals[agent.terminalId]?.sessionId : undefined
      const s = sessionId ? state.sessions[sessionId] : undefined
      if (!agent.terminalId || !sessionId || !s) {
        if (agent.agent === 'codex') {
          const launch = agent.terminalId ? codexLaunches.get(agent.terminalId) : undefined
          if (agent.terminalId && launch?.kind === 'tracked') {
            const blank = emptySession(launch.at)
            sections.push({
              terminalId: agent.terminalId, sessionId: `codex-launch:${agent.terminalId}`,
              title: agent.title ?? 'Codex', agent: 'codex', trustHook: true,
              drawn: '', lastActivity: launch.at, plan: null, planError: null, goal: null, tools: true, snoozed: {},
              ...labelledRows(blank, deps.clock.now()),
            })
          } else others.push({ key: agent.terminalId ?? `agent-${n}`, title: agent.title ?? 'Codex', agent: 'codex',
            ...(launch?.kind === 'skipped' ? { reason: 'launch-skipped' as const }
              : codexLaunchWithoutTerminal ? { reason: 'launch-unmatched' as const } : {}) })
          continue
        }
        untracked += 1
        continue
      }
      // Prefer the main agent's state when the host reports both.
      const mainState = agent.mainAgent?.state ?? agent.state
      if (!statuses.has(agent.terminalId) && STATES.includes(mainState)) statuses.set(agent.terminalId, mainState as TerminalStatus)
      unread += s.unread
      const { plan, error: planError, goal } = plans.get(sessionId) ?? (await readPlan(sessionId)) ?? { plan: null, error: null, goal: null }
      const pane = state.panes[state.terminals[agent.terminalId]?.paneKey ?? '']
      sections.push({
        terminalId: agent.terminalId,
        sessionId,
        title: agent.title ?? (s.agent === 'codex' ? 'Codex' : 'Claude Code'),
        ...(s.agent === 'codex' ? { agent: 'codex' as const, trustHook: pane?.threadId !== sessionId || !pane.promptHookSeen } : {}),
        drawn: drawnToken(s),
        lastActivity: s.touchedAt,
        plan,
        planError,
        goal,
        tools: s.tools,
        snoozed: snoozedIn(sessionId),
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

  // Orca opens only a path inside a workspace, relative to it: find the one local workspace that holds the session's folder.
  orca.panels.handle('inbox.openFile', async ({ sessionId, path }: { sessionId: string; path: string }): Promise<OpenOutcome> => {
    await ready
    try {
      const cwd = await dirOf(sessionId)
      if (!cwd) return { ok: false, error: "The agent's folder is not known" }
      const { workspaces, truncated } = (await orca.host.call('workspace.list', {})) as {
        workspaces: { id: string; path: string; hostId: string | null }[]
        truncated: boolean
      }
      if (truncated) return { ok: false, error: 'Orca listed only some workspaces' }
      // Every hit holds the cwd, so a longer path is a deeper one: the deepest wins, and only a tie at it fails.
      const hits = workspaces.filter(w => isLocal(w.hostId) && holds(w.path, cwd)).sort((x, y) => resolve(y.path).length - resolve(x.path).length)
      if (hits.length === 0) return { ok: false, error: 'No workspace holds this folder' }
      if (hits.length > 1 && resolve(hits[0].path) === resolve(hits[1].path)) return { ok: false, error: 'More than one workspace holds this folder' }
      const file = resolve(cwd, path)
      if (file === hits[0].path || !holds(hits[0].path, file)) return { ok: false, error: 'File is outside this workspace' }
      await orca.host.call('editor.open', { workspaceId: hits[0].id, path: relative(hits[0].path, file) })
      return { ok: true }
    } catch (e) {
      log(`open: ${message(e)}`)
      return { ok: false, error: message(e) }
    }
  })

  // Only the panel reads a snooze: the agent's `inbox:` text still lists the row as open.
  orca.panels.handle('inbox.snooze', async ({ sessionId, id, until }: { sessionId: string; id: string; until: number }): Promise<SnoozeOutcome> => {
    if (typeof sessionId !== 'string' || typeof id !== 'string' || typeof until !== 'number' || !(until > deps.clock.now()))
      return { ok: false, error: 'Not a snooze' }
    try {
      await snoozes(live => ({ ...live, [`${sessionId}:${id}`]: until }))
      orca.panels.post('inbox.changed', {})
      return { ok: true }
    } catch (e) {
      log(`snooze: ${message(e)}`)
      return { ok: false, error: message(e) }
    }
  })

  /** Rows with a hand-off out, by `<sessionId>:<rowId>`: one at a time per row. */
  const handingOff = new Set<string>()

  /**
   * A row's Hand off (spec "Hand off"): one `orca worktree create` that makes a child worktree of the session's folder
   * and starts the same agent kind there with the row's text. The receipt is saved on the row before the run, so a
   * restart mid-run reads "may have started". Only a clean error leaves the row as it was. Nothing is ever retried.
   */
  async function handOff(sessionId: string, id: string): Promise<HandoffOutcome> {
    await ready
    const s = tracker.state().sessions[sessionId]
    const row = s?.ledger.findings.find(f => f.id === id) ?? s?.ledger.items.find(i => i.id === id && i.kind === 'task')
    if (!s || !row) return { ok: false, error: 'Only an open finding or task can be handed off' }
    if (s.presses[id]?.handoff) return { ok: false, error: 'Handed off already' }
    const cwd = await dirOf(sessionId)
    if (!cwd) return { ok: false, error: "The agent's folder is not known" }
    const name = slug('ask' in row ? row.ask : row.title)
    const before = s.presses[id]
    const at = deps.clock.now()
    const label = (handoff: Handoff): PressLabel =>
      ({ state: handoff.outcome === 'running' ? 'sending' : handoff.outcome === 'started' ? 'answered' : 'undelivered', kind: 'handoff', answer: handoff.worktree, text: '', at, handoff })
    /** Puts back the row's label from before the press, and so its Hand off. */
    const restore = () => tracker.edit(sessionId, cur => {
      if (cur.presses[id]?.at !== at) return cur
      const { [id]: _, ...rest } = cur.presses
      return { ...cur, presses: before ? { ...rest, [id]: before } : rest }
    })
    try {
      await tracker.edit(sessionId, cur => setLabel(cur, id, label({ worktree: name, operationId: null, outcome: 'running' })))
    } catch (e) {
      // No receipt saved, so no run: a restart could not tell that it may have started.
      log(`handoff: save failed: ${message(e)}`)
      await restore().catch(() => undefined)
      return { ok: false, error: message(e) }
    }
    const reply = await deps.orca([
      'worktree', 'create', '--name', name, '--repo', `path:${cwd}`, '--parent-worktree', `path:${cwd}`,
      '--agent', s.agent, '--prompt', handoffText(row),
    ])
    if (reply.kind === 'error') {
      log(`handoff: ${reply.error}`)
      // Orca made nothing: the row goes back to its label before the press, and keeps Hand off.
      await restore()
      return { ok: false, error: reply.error }
    }
    let receipt: Handoff
    if (reply.kind === 'uncertain') {
      log(`handoff: may have started: ${reply.error}`)
      receipt = { worktree: name, operationId: reply.operationId, outcome: 'uncertain' }
    } else {
      const launch = launchOf(reply.result)
      receipt = launch.worktree === null
        ? { worktree: name, operationId: launch.operationId, outcome: 'uncertain' }
        : { worktree: launch.worktree, operationId: launch.operationId, outcome: launch.started ? 'started' : 'made' }
    }
    const saved = label(receipt)
    await tracker.edit(sessionId, cur => (cur.presses[id]?.at === at ? setLabel(cur, id, saved) : cur))
    return { ok: true, label: rowLabel(saved) }
  }

  orca.panels.handle('inbox.handoff', async ({ sessionId, id }: { sessionId: string; id: string }): Promise<HandoffOutcome> => {
    if (typeof sessionId !== 'string' || typeof id !== 'string') return { ok: false, error: 'Not a hand-off' }
    const key = `${sessionId}:${id}`
    // Taken before any wait, so a second press in the same moment finds it.
    if (handingOff.has(key)) return { ok: false, error: 'A hand-off for this row is already running' }
    handingOff.add(key)
    try {
      return await handOff(sessionId, id)
    } catch (e) {
      log(`handoff: ${message(e)}`)
      return { ok: false, error: message(e) }
    } finally {
      handingOff.delete(key)
    }
  })

  orca.panels.handle('inbox.press', async (input: PressInput) => {
    await ready
    return presses.press(input)
  })

  return {
    /** Settles once the socket file answers, or once listening failed. */
    listening: server.then(() => undefined),
    /** Closes the socket and removes its file. */
    async close(): Promise<void> {
      clearInterval(listing)
      const s = await server
      if (!s) return
      await new Promise<void>(resolve => s.close(() => resolve()))
    },
  }
}

let worker: { close(): Promise<void> } | null = null

/**
 * The socket and scripts for a worker Orca runs. `orca plugin check` and `orca plugin test` set ORCA_PLUGIN_TEST_ROOT
 * and start the worker on this machine: there it gets no socket, since one on the shared path would replace the live
 * worker's socket and remove it on close.
 */
export function liveTools(env: NodeJS.ProcessEnv): WorkerDeps['tools'] {
  return env.ORCA_PLUGIN_TEST_ROOT ? null : { socketPath: socketPath(), ...binPaths() }
}

export default function activate(orca: OrcaWorkerApi): void {
  worker = createWorker(orca, {
    clock: realClock,
    home: homedir(),
    model: (prompt, source, codexHome) => runInboxModel(prompt, { source, ...(codexHome === undefined ? {} : { codexHome }) }),
    readFile: readOrNull,
    listDirs,
    copy: text => copyToClipboard(text),
    orca: args => runOrca(args),
    tools: liveTools(process.env),
  })
}

export async function deactivate(): Promise<void> {
  await worker?.close()
}
