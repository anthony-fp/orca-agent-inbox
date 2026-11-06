// Runs src/worker.ts's createWorker(orca) over a mock host, with a fake clock, a fake file system and a fake model.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { EMPTY, applyUpdate, parseReply } from './core/ledger'
import type { ModelResult } from './model'
import { planPath } from './core/plan'
import { emptySession, type State } from './state'
import { fakeClock } from './test-clock'
import { PRUNE_MS } from './turns'
import { createWorker, liveTools } from './worker'
// @ts-expect-error: a plain Node script with no types
import { ask } from '../bin/ask.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binPaths } from './socket'

const HOME = '/home/someone'
const WS = { id: 'ws-1', kind: 'worktree', name: 'one', path: '/work/my_app.v2', branch: null, hostId: null }
const S = '0b0b0b0b-1111-4222-8333-444444444444'
const PROJECTS = `${HOME}/.claude/projects`
// Claude Code's own folder name: the worker never builds it, it finds the file by the session id.
const FILE = `${PROJECTS}/-work-my-app-v2/${S}.jsonl`
const PLAN_FILE = planPath(WS.path, S)
const DAY = 24 * 60 * 60 * 1000
const NONE = { shown: [], total: 0 }
const NO_FINDINGS = { issues: [], opportunities: [], closed: { issues: NONE, opportunities: NONE } }

const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, cwd: WS.path, isSidechain: false, origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'

const openLedger = () => {
  const u = parseReply('NEW: decide | 1 | Ship the parser today? | Yes / No | yes')
  assert.ok(u)
  return applyUpdate(EMPTY, u, 0, 1)
}

async function setup(opts: { state?: State; files?: Record<string, string>; unreadable?: string[]; agents?: unknown[]; copyFails?: boolean; list?: unknown[]; socket?: string } = {}) {
  const time = fakeClock(100 * DAY)
  const files = new Map(Object.entries(opts.files ?? {}))
  const reads: string[] = []
  const models: string[] = []
  const copied: string[] = []
  const host = mockHost({
    storage: opts.state ? { state: opts.state } : {},
    results: {
      'workspace.list': { workspaces: opts.list ?? [WS], truncated: false },
      'agents.list': { agents: opts.agents ?? [] },
      'terminal.sendText': { accepted: true },
    },
  })
  const deps = {
    clock: time.clock,
    home: HOME,
    tools: opts.socket ? { socketPath: opts.socket, ...binPaths() } : null,
    copy: async (text: string) => {
      if (opts.copyFails) throw new Error('no clipboard command on this system')
      copied.push(text)
    },
    model: async (p: string): Promise<ModelResult> => {
      models.push(p)
      const update = parseReply('NEW: decide | 1 | Rename the folder to tools? | Yes / No | yes')
      assert.ok(update)
      return { ok: true, update, text: '', ms: 1 }
    },
    listDirs: async (path: string) =>
      [...new Set([...files.keys()].filter(f => f.startsWith(`${path}/`)).map(f => f.slice(path.length + 1).split('/')[0]))],
    readFile: async (path: string) => {
      reads.push(path)
      if (opts.unreadable?.includes(path)) throw new Error('EACCES: permission denied')
      const text = files.get(path)
      return text === undefined ? null : Buffer.from(text)
    },
  }
  let made: ReturnType<typeof createWorker> | null = null
  const worker = await mountWorker({ default: (orca: Parameters<typeof createWorker>[0]) => (made = createWorker(orca, deps)) }, { host })
  await time.run()
  const saved = () => (host.data() as { storage: Record<string, State> }).storage.state
  return { worker, host, time, files, reads, models, saved, copied, close: () => made?.close() }
}

const launch = (command: string, over: Record<string, unknown> = {}) => ({
  agent: 'claude',
  workspaceId: WS.id,
  workspaceKind: null,
  terminalId: 'term-1',
  command,
  env: {},
  ...over,
})

const status = (state: string, over: Record<string, unknown> = {}) => ({
  workspaceId: WS.id,
  paneKey: 'pane-1',
  terminalId: 'term-1',
  state,
  receivedAt: 1,
  ...over,
})

test("the transcript is found by the session id in any project folder, and its path and cwd are saved on the session", async () => {
  const state: State = { version: 1, terminals: { 'term-1': { sessionId: S } }, sessions: { [S]: emptySession(100 * DAY) } }
  const t = await setup({ state, files: { [`${PROJECTS}/-other/${'9'.repeat(8)}.jsonl`]: '' } })
  await t.worker.emit('agent.status.changed', status('done'))
  await t.time.run(t.time.now() + 3000)
  assert.equal(t.saved()?.sessions[S].transcript ?? null, null, 'no file yet: pending, looked for again at the next read')
  t.files.set(FILE, prompt('p-1', 'Hi') + reply('a-1', 'Ship it?'))
  await t.worker.emit('agent.status.changed', status('done'))
  await t.time.run()
  assert.equal(t.models.length, 1)
  assert.equal(t.saved().sessions[S].transcript, FILE)
  assert.equal(t.saved().sessions[S].cwd, WS.path, "the cwd comes from the transcript's lines")
  const reads = t.reads.length
  await t.worker.emit('agent.status.changed', status('done'))
  await t.time.run()
  assert.ok(t.reads.slice(reads).every(p => p === FILE || p === PLAN_FILE), 'the saved path is read; no folder is searched again')
  await t.worker.deactivate()
})

test('the launch hook tags a new claude session and tracks its terminal', async () => {
  const t = await setup()
  const out = await t.worker.hooks.fire('agent.launch.before', launch('claude'))
  assert.equal(out.kind, 'continue')
  const command = out.kind === 'continue' ? String(out.event.command) : ''
  const id = /--session-id (\S+)/.exec(command)?.[1]
  assert.ok(id, command)
  assert.deepEqual(t.saved().terminals, { 'term-1': { sessionId: id} })
  assert.equal(t.saved().sessions[id].offset, 0)
  await t.worker.deactivate()
})

test('a launch that is not tracked passes through unchanged', async () => {
  const t = await setup()
  for (const event of [launch('codex', { agent: 'codex' }), launch('claude --continue')]) {
    const out = await t.worker.hooks.fire('agent.launch.before', event)
    assert.equal(out.kind === 'continue' && out.event.command, event.command)
  }
  assert.equal(t.saved(), undefined)
  await t.worker.deactivate()
})

test('a launch with no terminal is tagged; the prompt hook\'s terminal binds it, and inbox.view then shows its section', async () => {
  const TERM = 'term_0f0f0f0f-1111-4222-8333-444444444444'
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, agents: [{ terminalId: TERM, title: 'From the UI', agent: 'claude', state: 'working', stateStartedAt: 1 }] })
  const out = await t.worker.hooks.fire('agent.launch.before', launch('claude', { terminalId: undefined }))
  const id = /--session-id (\S+)/.exec(out.kind === 'continue' ? String(out.event.command) : '')?.[1]
  assert.ok(id, 'tagged without a terminal')
  assert.deepEqual(t.saved().terminals, {}, 'saved with no terminal mapping')
  assert.ok(t.saved().sessions[id])
  assert.deepEqual((await t.worker.request('inbox.view', undefined)).sections, [], 'no section before the first prompt')

  // A value that is not a terminal handle binds nothing.
  assert.deepEqual(await ask(socket, { type: 'prompt-start', sessionId: id, terminalId: '../etc' }, 2000), { text: '' })
  assert.deepEqual(t.saved().terminals, {})
  assert.deepEqual(await ask(socket, { type: 'prompt-start', sessionId: id, terminalId: TERM }, 2000), { text: '' })
  assert.deepEqual(t.saved().terminals, { [TERM]: { sessionId: id } })
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view.sections.map((s: { terminalId: string; sessionId: string }) => [s.terminalId, s.sessionId]), [[TERM, id]])
  await t.close()
  await t.worker.deactivate()
})

test('a --resume <uuid> session starts at the transcript end, not at 0', async () => {
  const old = prompt('p-1', 'Old prompt') + reply('a-1', 'Old reply?')
  const t = await setup({ files: { [FILE]: old + '{"type":"user","half' } })
  const out = await t.worker.hooks.fire('agent.launch.before', launch(`claude --resume ${S}`))
  assert.equal(out.kind === 'continue' && out.event.command, `claude --resume ${S}`)
  assert.equal(t.saved().sessions[S].offset, Buffer.byteLength(old))

  await t.worker.emit('agent.status.changed', status('done', { mainAgent: { state: 'done', stateStartedAt: 1 } }))
  await t.time.run()
  assert.equal(t.models.length, 0, 'the old turn is never read')
  await t.worker.deactivate()
})

test('status changes tell the panel to reload, at most once per 250 ms', async () => {
  const t = await setup()
  const posts = () => t.worker.posts.filter(p => p.event === 'inbox.changed').length
  const before = posts()
  // A new agent's or untracked agent's status reloads the panel too: agents.list gives what it shows.
  await t.worker.emit('agent.status.changed', status('working', { terminalId: 'term-9' }))
  await t.worker.emit('agent.status.changed', status('working', { terminalId: undefined }))
  await t.worker.emit('agent.status.changed', status('blocked', { terminalId: 'term-9' }))
  await t.time.run(t.time.now() + 249)
  assert.equal(posts(), before)
  await t.time.run(t.time.now() + 1)
  assert.equal(posts(), before + 1)
  await t.worker.emit('agent.status.changed', status('waiting', { terminalId: 'term-9' }))
  await t.time.run(t.time.now() + 250)
  assert.equal(posts(), before + 2)
  await t.worker.deactivate()
})

test('a status without terminalId is ignored', async () => {
  const t = await setup({ state: { version: 1, terminals: { 'term-1': { sessionId: S } }, sessions: { [S]: emptySession(100 * DAY) } } })
  const before = t.reads.length
  await t.worker.emit('agent.status.changed', status('done', { terminalId: undefined }))
  await t.time.run()
  assert.equal(t.reads.length, before)
  await t.worker.deactivate()
})

test('a done reads the transcript; the main agent state wins over the combined one', async () => {
  const state: State = { version: 1, terminals: { 'term-1': { sessionId: S } }, sessions: { [S]: emptySession(100 * DAY) } }
  const t = await setup({ state, files: {} })
  await t.worker.emit('agent.status.changed', status('done', { mainAgent: { state: 'working', stateStartedAt: 1 } }))
  t.files.set(FILE, prompt('p-1', 'Hi') + reply('a-1', 'Ship it?'))
  await t.time.run()
  assert.equal(t.models.length, 0, 'the main agent still works')

  await t.worker.emit('agent.status.changed', status('working', { mainAgent: { state: 'done', stateStartedAt: 1 } }))
  await t.time.run()
  assert.equal(t.models.length, 1)
  // The transcript, and the plan file the done reads again (spec "The session plan", step 2).
  assert.ok(t.reads.includes(FILE) && t.reads.every(p => p === FILE || p === PLAN_FILE))
  await t.worker.deactivate()
})

test('start prunes a session with no open rows untouched for 7 days, and its terminal; a live session keeps its terminal across restarts', async () => {
  const now = 100 * DAY
  const state: State = {
    version: 1,
    terminals: { open: { sessionId: 'kept-open' }, stale: { sessionId: 'stale' }, live: { sessionId: 'recent' }, orphan: { sessionId: 'gone' } },
    sessions: {
      'kept-open': { ...emptySession(now - 30 * DAY), ledger: openLedger() },
      stale: emptySession(now - PRUNE_MS - 1),
      recent: emptySession(now - DAY),
    },
  }
  const t = await setup({ state })
  assert.deepEqual(Object.keys(t.saved().terminals), ['open', 'live'])
  assert.deepEqual(Object.keys(t.saved().sessions).sort(), ['kept-open', 'recent'])
  await t.worker.deactivate()
  const again = await setup({ state: t.saved() })
  assert.deepEqual(Object.keys(again.saved().terminals), ['open', 'live'])
  await again.worker.deactivate()
})

test('inbox.view: one section per tracked agent, newest first, with the untracked and unread counts; inbox.press sends', async () => {
  const state: State = {
    version: 1,
    terminals: { 'term-1': { sessionId: S }, 'term-2': { sessionId: 's-2' } },
    sessions: { [S]: { ...emptySession(100 * DAY), ledger: openLedger(), lastTurnId: 'p-1', unread: 1 }, 's-2': emptySession(100 * DAY - 5) },
  }
  const agents = [
    { terminalId: 'term-2', title: 'Older', agent: 'claude', state: 'working', stateStartedAt: 1 },
    { terminalId: 'term-1', title: 'Fixer', agent: 'claude', state: 'done', stateStartedAt: 1 },
    { terminalId: 'term-3', title: 'Typed by hand', agent: 'claude', state: 'done', stateStartedAt: 1 },
    { terminalId: null, title: null, agent: 'codex', state: 'working', stateStartedAt: 1 },
  ]
  const t = await setup({ state, agents })
  const id = state.sessions[S].ledger.items[0].id
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view, {
    sections: [
      {
        terminalId: 'term-1',
        sessionId: S,
        title: 'Fixer',
        drawn: JSON.stringify(['p-1', []]),
        lastActivity: 100 * DAY,
        questions: [
          {
            id,
            // The ledger's turn is not the batch's, so the question is not numbered, as in the inbox.
            handle: '',
            text: 'Ship the parser today?',
            age: '100d',
            rec: 'Yes',
            choices: [
              { option: 'Yes', label: 'Yes', isRec: true, isFolded: false },
              { option: 'No', label: 'No', isRec: false, isFolded: false },
            ],
            steps: [],
            label: null,
          },
        ],
        tasks: [],
        closed: { questions: NONE, tasks: NONE },
        findings: NO_FINDINGS,
        plan: null,
        planError: null,
        tools: true,
      },
      {
        terminalId: 'term-2',
        sessionId: 's-2',
        title: 'Older',
        drawn: JSON.stringify([null, []]),
        lastActivity: 100 * DAY - 5,
        questions: [],
        tasks: [],
        closed: { questions: NONE, tasks: NONE },
        findings: NO_FINDINGS,
        plan: null,
        planError: null,
        tools: true,
      },
    ],
    // The Codex agent gets the Claude-only note and leaves the "not tracked" count, which keeps only Claude agents.
    others: [{ key: 'agent-3', title: 'Codex' }],
    untracked: 1,
    unread: 1,
  })

  // agents.list's `done` lets a press go after a worker restart, before any status event.
  const out = await t.worker.request('inbox.press', { terminalId: 'term-1', sessionId: S, drawn: JSON.stringify(['p-1', []]), id, action: 'answer', answer: 'Yes' })
  assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
  assert.deepEqual(t.host.callsOf('terminal.sendText'), [{ terminalId: 'term-1', text: 'Re "Ship the parser today?": Yes', enter: true }])
  assert.ok(t.worker.posts.some(p => p.event === 'inbox.changed'))
  await t.worker.deactivate()
})

test('inbox.view counts unread turns only for the sections it shows: the focused workspace, each terminal once', async () => {
  const state: State = {
    version: 1,
    terminals: { 'term-1': { sessionId: S }, 'term-2': { sessionId: 's-2' } },
    sessions: { [S]: { ...emptySession(100 * DAY), unread: 1 }, 's-2': { ...emptySession(100 * DAY), unread: 4 } },
  }
  // term-2 runs in another workspace, so agents.list (the focused workspace) leaves it out. Orca can give two
  // statuses that resolve to one terminal.
  const agents = [
    { terminalId: 'term-1', title: 'Here', agent: 'claude', state: 'done', stateStartedAt: 2 },
    { terminalId: 'term-1', title: 'Here', agent: 'claude', state: 'working', stateStartedAt: 1 },
  ]
  const t = await setup({ state, agents })
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view.sections.map((s: { terminalId: string }) => s.terminalId), ['term-1'])
  assert.deepEqual([view.unread, view.untracked, view.others.length], [1, 0, 0])
  await t.worker.deactivate()
})

test('inbox.view gives each section its plan, read again at a done; a changed plan tells the panel', async () => {
  const state: State = { version: 1, terminals: { 'term-1': { sessionId: S } }, sessions: { [S]: { ...emptySession(100 * DAY), cwd: WS.path } } }
  const agents = [{ terminalId: 'term-1', title: 'Fixer', agent: 'claude', state: 'done', stateStartedAt: 1 }]
  const t = await setup({ state, agents, files: { [PLAN_FILE]: '## Parser\n- [x] Read the spec\n- [~] Write the tests\n' } })
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view.sections[0].plan, {
    tasks: [{ title: 'Parser', steps: [{ text: 'Read the spec', mark: 'done' }, { text: 'Write the tests', mark: 'current' }], isOpen: true }],
    done: 1,
    total: 2,
    current: [{ text: 'Write the tests', mark: 'current' }],
  })
  const posts = t.worker.posts.length
  t.files.set(PLAN_FILE, '## Parser\n- [x] Read the spec\n- [x] Write the tests\n')
  await t.worker.emit('agent.status.changed', status('done'))
  await t.time.run()
  assert.ok(t.worker.posts.slice(posts).some(p => p.event === 'inbox.changed'))
  const again = await t.worker.request('inbox.view', undefined)
  assert.equal(again.sections[0].plan?.done, 2)
  await t.worker.deactivate()
})

test("inbox.view: a plan file that cannot be read, or has text but no step, gives its path as the error; a missing one gives none", async () => {
  const state: State = { version: 1, terminals: { 'term-1': { sessionId: S } }, sessions: { [S]: { ...emptySession(100 * DAY), cwd: WS.path } } }
  const agents = [{ terminalId: 'term-1', title: 'Fixer', agent: 'claude', state: 'done', stateStartedAt: 1 }]
  const planOf = async (opts: { files?: Record<string, string>; unreadable?: string[] }) => {
    const t = await setup({ state: structuredClone(state), agents, ...opts })
    const { plan, planError } = (await t.worker.request('inbox.view', undefined)).sections[0]
    await t.worker.deactivate()
    return { plan, planError }
  }
  assert.deepEqual(await planOf({ unreadable: [PLAN_FILE] }), { plan: null, planError: PLAN_FILE })
  assert.deepEqual(await planOf({ files: { [PLAN_FILE]: 'Notes, no checkbox step\n' } }), { plan: null, planError: PLAN_FILE })
  assert.deepEqual(await planOf({ files: { [PLAN_FILE]: '  \n' } }), { plan: null, planError: null })
  assert.deepEqual(await planOf({}), { plan: null, planError: null })
})

test('inbox.view: agents that are not Claude get the Claude-only list, by title, and count as nothing else', async () => {
  const agents = [
    { terminalId: 'term-5', title: 'Codex: review', agent: 'codex', state: 'working', stateStartedAt: 1 },
    { terminalId: 'term-6', title: null, agent: 'codex', state: 'done', stateStartedAt: 1 },
  ]
  const t = await setup({ agents })
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view, {
    sections: [],
    others: [
      { key: 'term-5', title: 'Codex: review' },
      { key: 'term-6', title: 'Codex' },
    ],
    untracked: 0,
    unread: 0,
  })
  await t.worker.deactivate()
})

test('a launch that got no tools marks its session, and its section says so', async () => {
  const t = await setup({ agents: [{ terminalId: 'term-1', title: 'Fixer', agent: 'claude', state: 'done', stateStartedAt: 1 }] })
  // No socket in the test (`tools: null`), so every launch here gets no tools, as one that sets its own --settings does.
  await t.worker.hooks.fire('agent.launch.before', launch(`claude --resume ${S} --settings x.json`))
  assert.equal(t.saved().sessions[S].tools, false)
  const view = await t.worker.request('inbox.view', undefined)
  assert.equal(view.sections[0].tools, false)
  assert.deepEqual(view.sections[0].findings, NO_FINDINGS)
  await t.worker.deactivate()
})

test('inbox.copy writes the clipboard, and says why when it cannot', async () => {
  const t = await setup()
  assert.deepEqual(await t.worker.request('inbox.copy', { text: 'PORT=4000' }), { ok: true })
  assert.deepEqual(t.copied, ['PORT=4000'])
  await t.worker.deactivate()
  const failing = await setup({ copyFails: true })
  assert.deepEqual(await failing.worker.request('inbox.copy', { text: 'x' }), { ok: false, error: 'no clipboard command on this system' })
  await failing.worker.deactivate()
})

// The live check (docs/live-check.md): the launch gives `<repoId>::<path>`, workspace.list gives `identity:<key>`.
test('repro: a launch workspaceId that workspace.list does not give still finds the transcript, and a restart keeps the terminal', async () => {
  const LIVE_WS = { ...WS, id: 'identity:wt2:local:x' }
  const t = await setup({ files: {}, list: [LIVE_WS] })
  const out = await t.worker.hooks.fire('agent.launch.before', launch(`claude --session-id ${S}`, { workspaceId: `repo-1::${WS.path}` }))
  assert.equal(out.kind, 'continue')
  t.files.set(FILE, prompt('p-1', 'Hi') + reply('a-1', 'Ship it?'))
  await t.worker.emit('agent.status.changed', status('done'))
  await t.time.run()
  assert.equal(t.models.length, 1, 'the turn was read and the inbox model ran')
  assert.ok(t.saved().sessions[S].offset > 0)
  const again = await setup({ files: { [FILE]: t.files.get(FILE)! }, list: [LIVE_WS], state: t.saved() })
  assert.deepEqual(Object.keys(again.saved().terminals), ['term-1'])
  await t.worker.deactivate()
  await again.worker.deactivate()
})

/** The worker over a mock host whose log lines are kept, and whose storage load can be held forever. */
async function logged(opts: { hang?: boolean } = {}) {
  const time = fakeClock(100 * DAY)
  const logs: string[] = []
  const host = mockHost({ storage: {}, results: { 'agents.list': { agents: [] } } })
  const deps = { clock: time.clock, home: HOME, tools: null, copy: async () => {}, model: async (): Promise<ModelResult> => ({ ok: false, reason: 'failed', detail: '', ms: 1 }), listDirs: async () => [], readFile: async () => null }
  const hung = { get: () => new Promise<never>(() => {}), set: async () => {}, delete: async () => {} }
  const wrap = (orca: Parameters<typeof createWorker>[0]) =>
    ({ ...orca, log: (m: string) => void logs.push(m), ...(opts.hang ? { storage: hung } : {}) }) as typeof orca
  const worker = await mountWorker({ default: (orca: Parameters<typeof createWorker>[0]) => createWorker(wrap(orca), deps) }, { host })
  await time.run()
  return { worker, time, logs, launches: () => logs.filter(l => l.startsWith('launch: ')) }
}

test('each launch logs one line with its tag and why it was not tagged, never the command', async () => {
  const t = await logged()
  assert.equal(t.logs[0], 'start: hooks registered')
  await t.worker.hooks.fire('agent.launch.before', launch('claude "secret prompt"', { workspaceKind: 'worktree' }))
  await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
  await t.worker.hooks.fire('agent.launch.before', launch('claude', { terminalId: undefined, workspaceKind: 'folder' }))
  await t.worker.hooks.fire('agent.launch.before', launch('claude --continue'))
  assert.deepEqual(t.launches(), [
    'launch: agent=claude terminal=yes workspaceKind=worktree tagged=new tools=no reason=-',
    'launch: agent=codex terminal=yes workspaceKind=none tagged=no tools=no reason=not-claude',
    'launch: agent=claude terminal=no workspaceKind=folder tagged=new tools=no reason=-',
    'launch: agent=claude terminal=yes workspaceKind=none tagged=no tools=no reason=continue',
  ])
  assert.ok(t.logs.every(l => !l.includes('secret')))
  await t.worker.deactivate()
})

test('the hook is registered before the state loads: a launch while storage never answers is still tagged and logged', async () => {
  const t = await logged({ hang: true })
  assert.equal(t.logs[0], 'start: hooks registered')
  const fired = t.worker.hooks.fire('agent.launch.before', launch('claude'))
  await t.time.run()
  const out = await fired
  assert.ok(out.kind === 'continue' && /--session-id \S+/.test(String(out.event.command)))
  assert.deepEqual(t.launches(), ['launch: agent=claude terminal=yes workspaceKind=none tagged=new tools=no reason=-'])
  await t.worker.deactivate()
})

test("a worker that orca plugin check or test starts gets no socket, so it never replaces the live worker's", () => {
  assert.equal(liveTools({ ORCA_PLUGIN_TEST_ROOT: '/some/plugin' }), null)
  assert.match(liveTools({})?.socketPath ?? '', /worker\.sock$/)
})
