// Runs src/worker.ts's createWorker(orca) over a mock host, with a fake clock, a fake file system and a fake model.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { EMPTY, applyUpdate, parseReply } from './core/ledger'
import type { ModelResult } from './model'
import { emptySession, type State } from './state'
import { fakeClock } from './test-clock'
import { PRUNE_MS } from './turns'
import { createWorker, projectSlug, transcriptPath } from './worker'

const HOME = '/home/someone'
const WS = { id: 'ws-1', kind: 'worktree', name: 'one', path: '/work/my_app.v2', branch: null, hostId: null }
const S = '0b0b0b0b-1111-4222-8333-444444444444'
const FILE = transcriptPath(HOME, WS.path, S)
const DAY = 24 * 60 * 60 * 1000
const NONE = { shown: [], total: 0 }

const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, isSidechain: false, origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'

const openLedger = () => {
  const u = parseReply('NEW: decide | 1 | Ship the parser today? | Yes / No | yes')
  assert.ok(u)
  return applyUpdate(EMPTY, u, 0, 1)
}

async function setup(opts: { state?: State; files?: Record<string, string>; agents?: unknown[] } = {}) {
  const time = fakeClock(100 * DAY)
  const files = new Map(Object.entries(opts.files ?? {}))
  const reads: string[] = []
  const models: string[] = []
  const host = mockHost({
    storage: opts.state ? { state: opts.state } : {},
    results: {
      'workspace.list': { workspaces: [WS], truncated: false },
      'agents.list': { agents: opts.agents ?? [] },
      'terminal.sendText': { accepted: true },
    },
  })
  const deps = {
    clock: time.clock,
    home: HOME,
    model: async (p: string): Promise<ModelResult> => {
      models.push(p)
      const update = parseReply('NEW: decide | 1 | Rename the folder to tools? | Yes / No | yes')
      assert.ok(update)
      return { ok: true, update, text: '', ms: 1 }
    },
    readFile: async (path: string) => {
      reads.push(path)
      const text = files.get(path)
      return text === undefined ? null : Buffer.from(text)
    },
  }
  const worker = await mountWorker({ default: (orca: Parameters<typeof createWorker>[0]) => createWorker(orca, deps) }, { host })
  await time.run()
  const saved = () => (host.data() as { storage: Record<string, State> }).storage.state
  return { worker, host, time, files, reads, models, saved }
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

test('the slug turns each character that is not a letter or digit into -', () => {
  assert.equal(projectSlug('/work/my_app.v2'), '-work-my-app-v2')
  assert.equal(FILE, `${HOME}/.claude/projects/-work-my-app-v2/${S}.jsonl`)
})

test('the launch hook tags a new claude session and tracks its terminal', async () => {
  const t = await setup()
  const out = await t.worker.hooks.fire('agent.launch.before', launch('claude'))
  assert.equal(out.kind, 'continue')
  const command = out.kind === 'continue' ? String(out.event.command) : ''
  const id = /--session-id (\S+)/.exec(command)?.[1]
  assert.ok(id, command)
  assert.deepEqual(t.saved().terminals, { 'term-1': { sessionId: id, workspaceId: WS.id } })
  assert.equal(t.saved().sessions[id].offset, 0)
  await t.worker.deactivate()
})

test('a launch that is not tracked passes through unchanged', async () => {
  const t = await setup()
  for (const event of [launch('codex', { agent: 'codex' }), launch('claude --continue'), launch('claude', { terminalId: undefined })]) {
    const out = await t.worker.hooks.fire('agent.launch.before', event)
    assert.equal(out.kind === 'continue' && out.event.command, event.command)
  }
  assert.equal(t.saved(), undefined)
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

test('a status without terminalId is ignored', async () => {
  const t = await setup({ state: { version: 1, terminals: { 'term-1': { sessionId: S, workspaceId: WS.id } }, sessions: { [S]: emptySession(100 * DAY) } } })
  const before = t.reads.length
  await t.worker.emit('agent.status.changed', status('done', { terminalId: undefined }))
  await t.time.run()
  assert.equal(t.reads.length, before)
  await t.worker.deactivate()
})

test('a done reads the transcript at the slug path; the main agent state wins over the combined one', async () => {
  const state: State = { version: 1, terminals: { 'term-1': { sessionId: S, workspaceId: WS.id } }, sessions: { [S]: emptySession(100 * DAY) } }
  const t = await setup({ state, files: {} })
  await t.worker.emit('agent.status.changed', status('done', { mainAgent: { state: 'working', stateStartedAt: 1 } }))
  t.files.set(FILE, prompt('p-1', 'Hi') + reply('a-1', 'Ship it?'))
  await t.time.run()
  assert.equal(t.models.length, 0, 'the main agent still works')

  await t.worker.emit('agent.status.changed', status('working', { mainAgent: { state: 'done', stateStartedAt: 1 } }))
  await t.time.run()
  assert.equal(t.models.length, 1)
  assert.ok(t.reads.length > 0 && t.reads.every(p => p === FILE))
  await t.worker.deactivate()
})

test('start prunes a terminal whose workspace is gone and a session with no open rows untouched for 7 days', async () => {
  const now = 100 * DAY
  const state: State = {
    version: 1,
    terminals: {
      gone: { sessionId: 'kept-open', workspaceId: 'ws-removed' },
      stale: { sessionId: 'stale', workspaceId: WS.id },
      live: { sessionId: 'recent', workspaceId: WS.id },
    },
    sessions: {
      'kept-open': { ...emptySession(now - 30 * DAY), ledger: openLedger() },
      stale: emptySession(now - PRUNE_MS - 1),
      recent: emptySession(now - DAY),
    },
  }
  const t = await setup({ state })
  assert.deepEqual(Object.keys(t.saved().terminals), ['live'])
  assert.deepEqual(Object.keys(t.saved().sessions).sort(), ['kept-open', 'recent'])
  await t.worker.deactivate()
})

test('inbox.view: one section per tracked agent, newest first, with the untracked and unread counts; inbox.press sends', async () => {
  const state: State = {
    version: 1,
    terminals: { 'term-1': { sessionId: S, workspaceId: WS.id }, 'term-2': { sessionId: 's-2', workspaceId: WS.id } },
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
      },
    ],
    untracked: 2,
    unread: 1,
  })

  // agents.list's `done` lets a press go after a worker restart, before any status event.
  const out = await t.worker.request('inbox.press', { terminalId: 'term-1', sessionId: S, drawn: JSON.stringify(['p-1', []]), id, action: 'answer', answer: 'Yes' })
  assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
  assert.deepEqual(t.host.callsOf('terminal.sendText'), [{ terminalId: 'term-1', text: 'Re "Ship the parser today?": Yes', enter: true }])
  assert.ok(t.worker.posts.some(p => p.event === 'inbox.changed'))
  await t.worker.deactivate()
})
