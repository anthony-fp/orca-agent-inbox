// Runs src/worker.ts's createWorker(orca) over a mock host, with a fake clock, a fake file system and a fake model.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { EMPTY, applyUpdate, parseReply } from './core/ledger'
import type { ModelResult } from './model'
import { planPath } from './core/plan'
import { drawnToken } from './presses'
import { emptySession, type CurrentState, type State } from './state'
import { fakeClock } from './test-clock'
import { PRUNE_MS } from './turns'
import { createWorker, liveTools } from './worker'
// @ts-expect-error: a plain Node script with no types
import { ask } from '../bin/ask.mjs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

async function setup(opts: { state?: State; storage?: Record<string, unknown>; files?: Record<string, string>; unreadable?: string[]; agents?: unknown[]; copyFails?: boolean; list?: unknown[]; truncated?: boolean; socket?: string; clockAt?: number; codexRollout?: (home: string, threadId: string) => Promise<{ path: string; cwd: string } | null> } = {}) {
  const time = fakeClock(opts.clockAt ?? 100 * DAY)
  const files = new Map(Object.entries(opts.files ?? {}))
  const reads: string[] = []
  const models: string[] = []
  const copied: string[] = []
  const host = mockHost({
    storage: { ...(opts.state ? { state: opts.state } : {}), ...opts.storage },
    results: {
      'workspace.list': { workspaces: opts.list ?? [WS], truncated: opts.truncated ?? false },
      'editor.open': { opened: true },
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
    codexRollout: opts.codexRollout,
    readFile: async (path: string) => {
      reads.push(path)
      if (opts.unreadable?.includes(path)) throw new Error('EACCES: permission denied')
      const text = files.get(path)
      return text === undefined ? null : Buffer.from(text)
    },
  }
  let made: ReturnType<typeof createWorker> | null = null
  const worker = await mountWorker({ default: (orca: Parameters<typeof createWorker>[0]) => (made = createWorker(orca, deps)) }, { host })
  // listen() does real file work, so the fake clock's ticks may end before the socket file exists.
  await made?.listening
  await time.run()
  const saved = () => (host.data() as { storage: Record<string, CurrentState> }).storage.state
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

test('a Claude launch in a former Codex terminal keeps its session after status', async () => {
  const old = { ...emptySession(100 * DAY), agent: 'codex' as const }
  const state: State = { version: 2, terminals: { 'term-1': { sessionId: 'thread-old', paneKey: 'pane-1' } },
    panes: { 'pane-1': { agent: 'codex', threadId: 'thread-old', codexHome: '/codex', promptHookSeen: true } },
    sessions: { 'thread-old': old } }
  const t = await setup({ state })
  await t.worker.hooks.fire('agent.launch.before', launch(`claude --session-id ${S}`))
  await t.worker.emit('agent.status.changed', status('working'))
  assert.deepEqual(t.saved().terminals['term-1'], { sessionId: S })
  assert.equal(t.saved().sessions[S].agent, 'claude')
  assert.equal(t.saved().panes['pane-1'], undefined)
  await t.worker.deactivate()
})

test('a tracked Codex relaunch clears its former pane before status', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const old = { ...emptySession(100 * DAY), agent: 'codex' as const }
  const state: State = { version: 2, terminals: { 'term-1': { sessionId: 'thread-old', paneKey: 'pane-1' } },
    panes: { 'pane-1': { agent: 'codex', threadId: 'thread-old', codexHome: '/codex', promptHookSeen: true } },
    sessions: { 'thread-old': old } }
  const t = await setup({ state, socket })
  try {
    const out = await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
    assert.equal(out.kind, 'continue')
    await t.worker.emit('agent.status.changed', status('working'))
    assert.equal(t.saved().panes['pane-1'], undefined)
    assert.equal(t.saved().terminals['term-1'], undefined)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('a skipped Codex launch clears a saved pane and refuses its old row press', async () => {
  const ledger = openLedger()
  const session = { ...emptySession(100 * DAY), agent: 'codex' as const, ledger }
  const state: State = { version: 2, terminals: { 'term-1': { sessionId: 'thread-old', paneKey: 'pane-1' } },
    panes: { 'pane-1': { agent: 'codex', threadId: 'thread-old', codexHome: '/codex', promptHookSeen: true } },
    sessions: { 'thread-old': session } }
  const t = await setup({ state, agents: [{ terminalId: 'term-1', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] })
  const out = await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
  assert.equal(out.kind === 'continue' && out.event.command, 'codex')
  await t.worker.emit('agent.status.changed', status('done'))
  await t.worker.request('inbox.press', { terminalId: 'term-1', sessionId: 'thread-old', drawn: drawnToken(session),
    id: ledger.items[0].id, action: 'answer', answer: 'Yes' })
  assert.equal(t.host.callsOf('terminal.sendText').length, 0)
  assert.equal(t.saved().terminals['term-1'], undefined)
  assert.equal(t.saved().panes['pane-1'], undefined)
  await t.worker.deactivate()
})

test('a skipped launch dates a known pane even before any thread binds', async () => {
  const t = await setup()
  await t.worker.emit('agent.status.changed', status('working'))
  await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
  assert.equal(t.saved().paneLaunches['pane-1'], 100 * DAY)
  assert.deepEqual(t.saved().panes, {})
  await t.worker.deactivate()
})

test('a tracked Codex launch followed by a skipped launch cannot send an old row', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, agents: [{ terminalId: 'term-1', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }],
    codexRollout: async () => ({ path: '/codex/rollout-2026-11-05T12-00-00-thread-new.jsonl', cwd: WS.path }) })
  try {
    await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
    await t.worker.emit('agent.status.changed', status('working'))
    await ask(socket, { type: 'prompt-start', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-new' }, 2000)
    await ask(socket, { type: 'record', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-new',
      args: { kind: 'question', ask: 'Ship it?', options: ['Yes', 'No'] } }, 2000)
    const session = t.saved().sessions['thread-new']
    const id = session.ledger.items[0].id
    const drawn = drawnToken(session)
    const skipped = await t.worker.hooks.fire('agent.launch.before', launch('codex -c notify=custom', { agent: 'codex' }))
    assert.equal(skipped.kind === 'continue' && skipped.event.command, 'codex -c notify=custom')
    await t.worker.emit('agent.status.changed', status('done'))
    await t.worker.request('inbox.press', { terminalId: 'term-1', sessionId: 'thread-new', drawn, id, action: 'answer', answer: 'Yes' })
    assert.equal(t.host.callsOf('terminal.sendText').length, 0)
    assert.equal(t.saved().panes['pane-1'], undefined)
    assert.equal(t.saved().terminals['term-1'], undefined)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('a late old notify cannot rebind a pane cleared by relaunch', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const old = { ...emptySession(), agent: 'codex' as const, touchedAt: Date.parse('2026-11-05T10:30:00Z') }
  const state: State = { version: 2, terminals: { 'term-1': { sessionId: 'thread-old', paneKey: 'pane-1' } },
    panes: { 'pane-1': { agent: 'codex', threadId: 'thread-old', codexHome: '/codex', promptHookSeen: true } },
    sessions: { 'thread-old': old } }
  const t = await setup({ state, socket, clockAt: Date.parse('2026-11-05T11:00:00Z'),
    codexRollout: async () => ({ path: '/codex/rollout-2026-11-05T10-00-00-thread-old.jsonl', cwd: WS.path }) })
  try {
    await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
    assert.equal(t.saved().paneLaunches['pane-1'], Date.parse('2026-11-05T11:00:00Z'))
    await ask(socket, { type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: '/codex', threadId: 'thread-old',
      turnId: 'turn-old', type: 'agent-turn-complete' } }, 2000)
    assert.equal(t.saved().panes['pane-1'], undefined)
    assert.equal(t.saved().terminals['term-1'], undefined)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('concurrent old and new binds leave the new Codex thread bound', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  let resolveOld!: (value: { path: string; cwd: string }) => void
  let oldStarted!: () => void
  const started = new Promise<void>(resolve => { oldStarted = resolve })
  const t = await setup({ socket, codexRollout: async (_home, threadId) => {
    if (threadId === 'thread-old') {
      oldStarted()
      return new Promise(resolve => { resolveOld = resolve })
    }
    return { path: '/codex/rollout-2026-11-05T11-00-00-thread-new.jsonl', cwd: WS.path }
  } })
  const notify = (threadId: string) => ask(socket, { type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: '/codex',
    threadId, turnId: `turn-${threadId}`, type: 'agent-turn-complete' } }, 2000)
  try {
    const oldCall = notify('thread-old')
    await started
    const newCall = notify('thread-new')
    resolveOld({ path: '/codex/rollout-2026-11-05T10-00-00-thread-old.jsonl', cwd: WS.path })
    await Promise.all([oldCall, newCall])
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-new')
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('a first-turn Codex tool saves before notify; status ties its pane to the terminal', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, codexRollout: async (home, threadId) => {
    assert.equal(home, '/codex', 'no other account home is guessed before notify')
    return { path: `/codex/sessions/2026/11/05/rollout-${threadId}.jsonl`, cwd: WS.path }
  } })
  try {
    const answer = await ask(socket, { type: 'record', paneKey: 'pane-1', codexHome: '', sessionId: 'thread-1', args: { kind: 'finding', finding_kind: 'issue', title: 'Retry loop', detail: 'It never stops.' } }, 2000)
    assert.match(answer?.text ?? '', /^Recorded\./)
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-1')
    assert.equal(t.saved().panes['pane-1'].codexHome, '')
    assert.equal(t.saved().sessions['thread-1'].ledger.findings[0].title, 'Retry loop')
    assert.equal(t.saved().sessions['thread-1'].activeTurn, 1)
    await t.worker.emit('agent.status.changed', status('working', { paneKey: 'pane-1' }))
    assert.deepEqual(t.saved().terminals, { 'term-1': { sessionId: 'thread-1', paneKey: 'pane-1' } })
    assert.deepEqual(await ask(socket, { type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: '/codex', threadId: 'thread-1', turnId: 'turn-1', type: 'agent-turn-complete' } }, 2000), { text: '' })
    assert.equal(t.saved().panes['pane-1'].codexHome, '/codex')
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('a newer rollout rebinds a pane; late old notify, prompt and tool calls leave it bound', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, codexRollout: async (_home, threadId) => threadId.startsWith('sub') ? null : ({ path: `/codex/sessions/2026/11/05/rollout-2026-11-05T${threadId === 'thread-1' ? '10' : '11'}-00-00-${threadId}.jsonl`, cwd: WS.path }) })
  const notify = async (threadId: string) => ask(socket, { type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: '/codex', threadId, turnId: `turn-${threadId}`, type: 'agent-turn-complete' } }, 2000)
  try {
    assert.deepEqual(await notify('thread-1'), { text: '' })
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-1')
    assert.deepEqual(await notify('sub-1'), { text: '' })
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-1')
    assert.deepEqual(await notify('thread-2'), { text: '' })
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-2')
    assert.equal(t.saved().panes['pane-1'].promptHookSeen, false)
    await notify('thread-1')
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-2')
    await ask(socket, { type: 'prompt-start', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-1' }, 2000)
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-2')
    await ask(socket, { type: 'record', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-1', args: { kind: 'finding', finding_kind: 'issue', title: 'Old', detail: 'Old thread' } }, 2000)
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-2')
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('a prompt hook rebinds a new main thread without rollout times, while notify does not', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, codexRollout: async (_home, threadId) =>
    ({ path: `/codex/rollout-${threadId}.jsonl`, cwd: WS.path }) })
  try {
    const notify = (threadId: string) => ask(socket, { type: 'codex-turn', payload: {
      paneKey: 'pane-1', codexHome: '/codex', threadId, turnId: `turn-${threadId}`, type: 'agent-turn-complete',
    } }, 2000)
    await ask(socket, { type: 'prompt-start', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-old' }, 2000)
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-old')
    await notify('thread-new')
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-old')
    await ask(socket, { type: 'prompt-start', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-new' }, 2000)
    assert.equal(t.saved().panes['pane-1'].threadId, 'thread-new')
    assert.equal(t.saved().panes['pane-1'].promptHookSeen, true)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('a notify with a missing rollout is kept until a later status can verify it', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const path = '/codex/sessions/2026/11/05/rollout-chat-1.jsonl'
  let available = false
  const rollout = readFileSync(new URL('./core/fixtures/codex-one.jsonl', import.meta.url)).toString('utf8')
  const t = await setup({ socket, files: { [path]: rollout }, codexRollout: async () => available ? { path, cwd: WS.path } : null })
  try {
    const request = { type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: '/codex', threadId: 'chat-1', turnId: 'turn-1', type: 'agent-turn-complete' } }
    assert.deepEqual(await ask(socket, request, 2000), { text: '' })
    assert.equal(t.saved().panes['pane-1'], undefined, 'an unverified thread does not bind')
    assert.equal(t.saved().pendingCodex?.['pane-1']?.[0].turnId, 'turn-1')
    available = true
    await t.worker.emit('agent.status.changed', status('working', { paneKey: 'pane-1' }))
    assert.equal(t.saved().panes['pane-1'].threadId, 'chat-1')
    assert.equal(t.saved().pendingCodex, undefined)
    await t.worker.emit('agent.status.changed', status('done', { paneKey: 'pane-1' }))
    await t.time.run()
    assert.equal(t.models.length, 1)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
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

test('a Claude /resume follows the new transcript without reading old turns and routes launch-id tools there', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const next = 'bbbbbbbb-1111-4222-8333-444444444444'
  const file = `${PROJECTS}/-work-my-app-v2/${next}.jsonl`
  const old = prompt('p-old', 'Old prompt') + reply('a-old', 'Old reply')
  const t = await setup({ socket, files: { [file]: old } })
  try {
    await t.worker.hooks.fire('agent.launch.before', launch(`claude --resume ${S}`))
    assert.deepEqual(await ask(socket, { type: 'prompt-start', sessionId: next, launchSession: S, transcript: file, cwd: WS.path }, 2000), { text: '' })
    assert.equal(t.saved().terminals['term-1'].sessionId, next)
    assert.equal(t.saved().sessions[next].offset, Buffer.byteLength(old))
    assert.equal(t.saved().sessions[next].ledger.turn, 1)
    await t.worker.emit('agent.status.changed', status('done'))
    await t.time.run()
    assert.equal(t.models.length, 0)
    assert.match(JSON.stringify(await ask(socket, { type: 'record', sessionId: S, args: { kind: 'question', ask: 'New conversation?', options: ['Yes', 'No'] } }, 2000)), /Recorded/)
    assert.equal(t.saved().sessions[next].ledger.items[0].ask, 'New conversation?')
    assert.equal(t.saved().sessions[S].ledger.items.length, 0)
    t.files.set(file, old + prompt('p-new', 'New prompt') + reply('a-new', 'New reply'))
    await t.worker.emit('agent.status.changed', status('done'))
    await t.time.run()
    assert.equal(t.models.length, 1)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
})

test('Claude /clear starts at zero, aliases chain, and switching back preserves a known offset', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const b = 'bbbbbbbb-1111-4222-8333-444444444444'
  const c = 'cccccccc-1111-4222-8333-444444444444'
  const bFile = `${PROJECTS}/-work-my-app-v2/${b}.jsonl`
  const cFile = `${PROJECTS}/-work-my-app-v2/${c}.jsonl`
  const t = await setup({ socket })
  try {
    await t.worker.hooks.fire('agent.launch.before', launch(`claude --resume ${S}`))
    await ask(socket, { type: 'prompt-start', sessionId: b, launchSession: S, transcript: bFile }, 2000)
    assert.equal(t.saved().sessions[b].offset, 0)
    assert.equal(t.saved().sessions[b].transcript, bFile)
    assert.equal(t.saved().terminals['term-1'].sessionId, b)
    t.files.set(bFile, prompt('p-b', 'B prompt') + reply('a-b', 'B reply'))
    await t.worker.emit('agent.status.changed', status('done'))
    await t.time.run()
    const savedOffset = t.saved().sessions[b].offset
    assert.ok(savedOffset > 0)
    await ask(socket, { type: 'prompt-start', sessionId: c, launchSession: S, transcript: cFile }, 2000)
    assert.equal(t.saved().moved?.[S], c)
    await ask(socket, { type: 'record', sessionId: S, args: { kind: 'question', ask: 'Third conversation?', options: ['Yes', 'No'] } }, 2000)
    assert.equal(t.saved().sessions[c].ledger.items[0].ask, 'Third conversation?')
    assert.deepEqual(t.saved().sessions[b].ledger.items.map(item => item.ask), ['Rename the folder to tools?'],
      'b keeps the question produced by the fake inbox model for its reply turn')
    await ask(socket, { type: 'prompt-start', sessionId: b, launchSession: S }, 2000)
    assert.equal(t.saved().terminals['term-1'].sessionId, b)
    assert.equal(t.saved().sessions[b].offset, savedOffset, 'a known session keeps its saved offset')
    assert.equal(t.saved().moved?.[S], b)
    await ask(socket, { type: 'prompt-start', sessionId: S }, 2000)
    assert.equal(t.saved().terminals['term-1'].sessionId, S)
    assert.equal(t.saved().moved?.[S], undefined)
  } finally {
    await t.close()
    await t.worker.deactivate()
  }
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

test('prune keeps an alias while its target lives, so launch-id tools still reach the switched session', async () => {
  const now = 100 * DAY
  const current = 'cccccccc-1111-4222-8333-444444444444'
  const state: State = {
    version: 3, terminals: { 'term-1': { sessionId: current } }, panes: {}, paneLaunches: {},
    sessions: { [S]: emptySession(now - PRUNE_MS - 1), [current]: emptySession(now - DAY) },
    moved: { [S]: current },
  }
  const t = await setup({ state })
  assert.ok(t.saved().sessions[S], 'the launch session stays while its alias target lives')
  assert.equal(t.saved().moved?.[S], current)
  await t.worker.deactivate()
  const again = await setup({ state: t.saved() })
  assert.equal(again.saved().moved?.[S], current, 'the alias survives a restart')
  await again.worker.deactivate()
})

test('prune keeps a whole alias chain to a live session across a restart, and drops a chain with no live session', async () => {
  const now = 100 * DAY
  const [a, b, c, x, y] = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'].map(p => `${p}-1111-4222-8333-444444444444`)
  const old = emptySession(now - PRUNE_MS - 1)
  const state: State = {
    version: 3, terminals: {}, panes: {}, paneLaunches: {},
    sessions: { [a]: old, [b]: old, [c]: emptySession(now - DAY), [x]: old, [y]: old },
    moved: { [a]: b, [b]: c, [x]: y, [y]: x },
  }
  const t = await setup({ state })
  await t.worker.deactivate()
  const again = await setup({ state: t.saved() })
  assert.deepEqual(Object.keys(again.saved().sessions).sort(), [a, b, c].sort())
  assert.deepEqual(again.saved().moved, { [a]: b, [b]: c })
  await again.worker.deactivate()
})

test('an older launch still reading its transcript does not bind over a newer launch in the same terminal', async () => {
  const t = await setup({ files: { [`${PROJECTS}/-work-my-app/${S}.jsonl`]: prompt('p-1', 'old') } })
  const older = t.worker.hooks.fire('agent.launch.before', launch(`claude --resume ${S}`))
  const newer = t.worker.hooks.fire('agent.launch.before', launch('claude'))
  await Promise.all([older, newer])
  await t.time.run()
  const bound = t.saved().terminals['term-1']?.sessionId
  assert.ok(bound && bound !== S, `the newer launch keeps the terminal, got ${bound}`)
  await t.worker.deactivate()
})

test('a new launch in a terminal ends its old Claude binding, so a press cannot reach the new process', async () => {
  const state: State = { version: 3, terminals: { 'term-1': { sessionId: S } }, panes: {}, paneLaunches: {}, sessions: { [S]: emptySession(100 * DAY) } }
  const t = await setup({ state })
  await t.worker.hooks.fire('agent.launch.before', launch('claude --continue'))
  await t.time.run()
  assert.equal(t.saved().terminals['term-1'], undefined)
  await t.worker.deactivate()
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
            path: null,
            label: null,
            explained: false,
          },
        ],
        tasks: [],
        closed: { questions: NONE, tasks: NONE },
        findings: NO_FINDINGS,
        plan: null,
        planError: null,
        tools: true,
        snoozed: {},
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
        snoozed: {},
      },
    ],
    // The Codex agent gets its untracked note; the count covers only Claude agents.
    others: [{ key: 'agent-3', title: 'Codex', agent: 'codex' }],
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

test('inbox.view: Codex agents without a seen launch get the untracked section', async () => {
  const agents = [
    { terminalId: 'term-5', title: 'Codex: review', agent: 'codex', state: 'working', stateStartedAt: 1 },
    { terminalId: 'term-6', title: null, agent: 'codex', state: 'done', stateStartedAt: 1 },
  ]
  const t = await setup({ agents })
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view, {
    sections: [],
    others: [
      { key: 'term-5', title: 'Codex: review', agent: 'codex' },
      { key: 'term-6', title: 'Codex', agent: 'codex' },
    ],
    untracked: 0,
    unread: 0,
  })
  await t.worker.deactivate()
})

test('inbox.view: a Codex launch has a hook-trust section before its first thread signal', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, agents: [{ terminalId: 'term-1', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 1 }] })
  const out = await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex' }))
  assert.equal(out.kind, 'continue')
  const view = await t.worker.request('inbox.view', undefined)
  assert.equal(view.sections.length, 1)
  assert.equal(view.sections[0].trustHook, true)
  assert.equal(view.sections[0].agent, 'codex')
  assert.deepEqual(view.others, [])
  assert.deepEqual(await t.worker.request('inbox.press', { terminalId: 'term-1', sessionId: view.sections[0].sessionId,
    drawn: '', id: 'i1', action: 'answer', answer: 'Yes' }), { ok: false, refused: 'invalid' })
  await t.close()
  await t.worker.deactivate()
})

test('a Codex launch without terminal identity gets an uncertain note until a thread binds', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ socket, agents: [{ terminalId: 'term-1', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 1 }] })
  await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex', terminalId: undefined }))
  const view = await t.worker.request('inbox.view', undefined)
  assert.deepEqual(view.sections, [])
  assert.deepEqual(view.others, [{ key: 'term-1', title: 'Codex', agent: 'codex', reason: 'launch-unmatched' }])
  await t.close()
  await t.worker.deactivate()
})

test('inbox.view: a tracked Codex thread has Claude-shaped rows and clears hook-trust after a prompt', async () => {
  const ledger = openLedger()
  const session = { ...emptySession(100 * DAY), agent: 'codex' as const, codexHome: '/codex', ledger }
  const state: State = { version: 2, terminals: { 'term-1': { sessionId: S } },
    sessions: { [S]: session }, panes: { 'pane-1': { agent: 'codex', threadId: S, codexHome: '/codex', promptHookSeen: true } } }
  const t = await setup({ state, agents: [{ terminalId: 'term-1', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] })
  assert.equal((await t.worker.request('inbox.view', undefined)).sections[0].trustHook, true)
  await t.worker.emit('agent.status.changed', status('done', { paneKey: 'pane-1' }))
  assert.equal(t.saved().terminals['term-1'].paneKey, 'pane-1')
  const view = await t.worker.request('inbox.view', undefined)
  assert.equal(view.sections.length, 1)
  assert.equal(view.sections[0].agent, 'codex')
  assert.equal(view.sections[0].trustHook, false)
  assert.equal(view.sections[0].questions[0].text, ledger.items[0].ask)
  assert.deepEqual(view.others, [])
  await t.worker.deactivate()

  const other = await setup({ state: { ...state, terminals: { 'term-2': { sessionId: S, paneKey: 'pane-2' } }, panes: {
    ...state.panes, 'pane-2': { agent: 'codex', threadId: S, codexHome: '/codex', promptHookSeen: false },
  } }, agents: [{ terminalId: 'term-2', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] })
  assert.equal((await other.worker.request('inbox.view', undefined)).sections[0].trustHook, true)
  await other.worker.deactivate()
})

for (const main of ['working', 'blocked', 'waiting', 'done'] as const) {
  test(`Codex mainAgent ${main} allows the press send despite combined done`, async () => {
    const ledger = openLedger()
    const session = { ...emptySession(100 * DAY), agent: 'codex' as const, codexHome: '/codex', ledger }
    const state: State = { version: 2, terminals: { 'term-1': { sessionId: S, paneKey: 'pane-1' } },
      sessions: { [S]: session }, panes: { 'pane-1': { agent: 'codex', threadId: S, codexHome: '/codex', promptHookSeen: true } } }
    const t = await setup({ state, agents: [{ terminalId: 'term-1', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] })
    await t.worker.emit('agent.status.changed', status('done', { mainAgent: { state: main, stateStartedAt: 1 } }))
    const out = await t.worker.request('inbox.press', { terminalId: 'term-1', sessionId: S, drawn: drawnToken(session),
      id: ledger.items[0].id, action: 'answer', answer: 'Yes' })
    assert.equal(out.ok && out.label?.text, 'Sending…')
    assert.equal(t.host.callsOf('terminal.sendText').length, 1)
    await t.worker.deactivate()
  })
}

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

test('inbox.openFile opens the file in the one local workspace that holds the folder, by its path relative to it', async () => {
  /** Opens `path` for a session in `cwd`, and gives the outcome and the editor.open calls. */
  const openIn = async (cwd: string, path: string, opts: { list?: unknown[]; truncated?: boolean } = {}) => {
    const state: State = { version: 1, terminals: {}, sessions: { [S]: { ...emptySession(100 * DAY), cwd } } }
    const t = await setup({ state, ...opts })
    const out = await t.worker.request('inbox.openFile', { sessionId: S, path })
    const calls = t.host.callsOf('editor.open')
    await t.worker.deactivate()
    return { out, calls }
  }
  const sub = `${WS.path}/pkg`
  assert.deepEqual(await openIn(sub, 'src/a.ts'), { out: { ok: true }, calls: [{ workspaceId: WS.id, path: 'pkg/src/a.ts' }] })
  assert.deepEqual((await openIn(sub, `${WS.path}/README.md`)).calls, [{ workspaceId: WS.id, path: 'README.md' }], 'an absolute path inside')
  const remote = { ...WS, id: 'ws-remote', hostId: 'ssh:box' }
  assert.deepEqual((await openIn(sub, 'a.ts', { list: [remote, WS] })).calls, [{ workspaceId: WS.id, path: 'pkg/a.ts' }], 'the same path on another host is not this one')
  const B = { ...WS, id: 'ws-b', path: '/a/b' }
  const BC = { ...WS, id: 'ws-bc', path: '/a/bc', hostId: 'local' }
  const FOLDER = { ...WS, id: 'ws-a', kind: 'folder', path: '/a' }
  const WT = { ...WS, id: 'ws-wt', path: '/a/wt', hostId: 'local' }
  assert.deepEqual((await openIn('/a/wt/sub', 'x.ts', { list: [FOLDER, WT] })).calls, [{ workspaceId: 'ws-wt', path: 'sub/x.ts' }], 'the deepest workspace wins')
  assert.deepEqual((await openIn('/a/bc', 'x.ts', { list: [B, BC] })).calls, [{ workspaceId: 'ws-bc', path: 'x.ts' }], '/a/b does not hold /a/bc')

  const fails = async (cwd: string, path: string, error: string, opts: { list?: unknown[]; truncated?: boolean } = {}) =>
    assert.deepEqual(await openIn(cwd, path, opts), { out: { ok: false, error }, calls: [] })
  await fails(sub, '../../../etc/hosts', 'File is outside this workspace')
  await fails(sub, '/etc/hosts', 'File is outside this workspace')
  await fails('/a/bc', 'x.ts', 'No workspace holds this folder', { list: [B, remote] })
  await fails(sub, 'a.ts', 'More than one workspace holds this folder', { list: [{ ...WS, path: '/work' }, WS, { ...WS, id: 'ws-2', hostId: 'local' }] })
  await fails(sub, 'a.ts', 'Orca listed only some workspaces', { truncated: true })
})

test('a snooze saves under its own key and leaves the state alone, survives a restart, and is dropped once it ends; the inbox: text still lists the row', async () => {
  const HOUR = 60 * 60 * 1000
  const ledger = openLedger()
  const id = ledger.items[0].id
  const state: State = { version: 3, terminals: { 'term-1': { sessionId: S } }, panes: {}, paneLaunches: {}, sessions: { [S]: { ...emptySession(100 * DAY), ledger } } }
  const agents = [{ terminalId: 'term-1', title: 'Agent', agent: 'claude', state: 'done', stateStartedAt: 1 }]
  const socket = join(mkdtempSync(join(tmpdir(), 'oai-')), 'w.sock')
  const t = await setup({ state, agents, socket })
  const until = 100 * DAY + HOUR
  const before = JSON.stringify(t.saved())
  assert.deepEqual(await t.worker.request('inbox.snooze', { sessionId: S, id, until }), { ok: true })
  const storage = () => (t.host.data() as { storage: Record<string, unknown> }).storage
  assert.deepEqual(storage().snoozes, { [`${S}:${id}`]: until })
  assert.equal(JSON.stringify(t.saved()), before, 'the state, and its version 3, do not change')
  assert.deepEqual(await t.worker.request('inbox.snooze', { sessionId: S, id, until: 100 * DAY }), { ok: false, error: 'Not a snooze' }, 'a time already past')
  const section = (await t.worker.request('inbox.view', undefined)).sections[0]
  assert.deepEqual(section.snoozed, { [id]: until })
  assert.equal(section.questions.length, 1, 'the worker still sends the row; the panel hides it')
  const told = await ask(socket, { type: 'inbox-text', sessionId: S, prompt: 'next' }, 2000)
  assert.match(String(told.text), /Ship the parser today\?/, 'the agent still sees the row open')
  await t.close()
  await t.worker.deactivate()

  const restarted = await setup({ state: t.saved(), storage: { snoozes: storage().snoozes }, agents })
  assert.deepEqual((await restarted.worker.request('inbox.view', undefined)).sections[0].snoozed, { [id]: until }, 'kept across a restart')
  await restarted.worker.deactivate()

  const ended = await setup({ state: t.saved(), storage: { snoozes: storage().snoozes }, agents, clockAt: until })
  assert.deepEqual((await ended.worker.request('inbox.view', undefined)).sections[0].snoozed, {})
  assert.deepEqual((ended.host.data() as { storage: Record<string, unknown> }).storage.snoozes, {}, 'dropped from storage once it ends')
  await ended.worker.deactivate()
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
async function logged(opts: { hang?: boolean; tools?: { socketPath: string; mcpServer: string; promptHook: string } } = {}) {
  const time = fakeClock(100 * DAY)
  const logs: string[] = []
  const host = mockHost({ storage: {}, results: { 'agents.list': { agents: [] } } })
  const deps = { clock: time.clock, home: HOME, tools: opts.tools ?? null, copy: async () => {}, model: async (): Promise<ModelResult> => ({ ok: false, reason: 'failed', detail: '', ms: 1 }), listDirs: async () => [], readFile: async () => null }
  const hung = { get: () => new Promise<never>(() => {}), set: async () => {}, delete: async () => {} }
  const wrap = (orca: Parameters<typeof createWorker>[0]) =>
    ({ ...orca, log: (m: string) => void logs.push(m), ...(opts.hang ? { storage: hung } : {}) }) as typeof orca
  let made: ReturnType<typeof createWorker> | null = null
  const worker = await mountWorker({ default: (orca: Parameters<typeof createWorker>[0]) => (made = createWorker(wrap(orca), deps)) }, { host })
  await time.run()
  return { worker, time, logs, launches: () => logs.filter(l => l.startsWith('launch: ')), close: async () => { await made?.close() } }
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

test('Claude and Codex launches use copied scripts beside the socket', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'inbox-scripts-')), 'worker.sock')
  const t = await logged({ tools: { socketPath: socket, ...binPaths() } })
  const claude = await t.worker.hooks.fire('agent.launch.before', launch('claude', { terminalId: undefined }))
  const codex = await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex', terminalId: undefined }))
  const claudeCommand = String(claude.event.command)
  const codexCommand = String(codex.event.command)
  for (const command of [claudeCommand, codexCommand]) {
    assert.ok(command.includes(join(socket, '..', 'bin', 'mcp-server.mjs')))
    assert.ok(command.includes(join(socket, '..', 'bin', 'prompt-hook.mjs')))
    assert.ok(!command.includes(dirname(binPaths().mcpServer)))
  }
  assert.ok(codexCommand.includes(join(socket, '..', 'bin', 'codex-notify.mjs')))
  await t.close()
  await t.worker.deactivate()
})

test('script copy failure logs and uses install paths for the launch', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'inbox-scripts-')), 'worker.sock')
  const install = join(socket, '..', 'missing-bin')
  const t = await logged({ tools: { socketPath: socket, mcpServer: join(install, 'mcp-server.mjs'), promptHook: join(install, 'prompt-hook.mjs') } })
  const result = await t.worker.hooks.fire('agent.launch.before', launch('codex', { agent: 'codex', terminalId: undefined }))
  assert.match(String(result.event.command), /missing-bin\/mcp-server\.mjs/)
  assert.ok(t.logs.some(line => line.startsWith('scripts: could not copy: ')))
  await t.close()
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
