// The worker's socket, the turn stamp on tool calls (spec "The agent's tools", step 4), and the two bin scripts
// against fake sockets (plan T10).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// @ts-expect-error: a plain Node script with no types
import { ask } from '../bin/ask.mjs'
// @ts-expect-error: a plain Node script with no types
import { main as runCodexNotify, notifyCommand, notifyRequest } from '../bin/codex-notify.mjs'
import { parseReply } from './core/ledger'
import { ORCA, inboxText } from './core/model-text'
import { planNote } from './core/plan'
import { agentTools, recordItem } from './core/tools'
import type { ModelResult } from './model'
import { activeTurn, binPaths, createAnswerer, listen, socketPath, type Answer } from './socket'
import { STATE_KEY, type State } from './state'
import { fakeClock } from './test-clock'
import { createTracker } from './turns'

const S = 'session-1'
const T = 'terminal-1'
const BIN = fileURLToPath(new URL('../bin/', import.meta.url))
const PLAN = planNote('/work/app/.inbox/plans/session-1.md', null)

const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, isSidechain: false, origin: { kind: 'human' }, turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'
const turn = (n: number) => prompt(`p-${n}`, `Prompt ${n}`) + reply(`a-${n}`, `Reply ${n}.`)

const QUESTION = { kind: 'question', ask: 'Use the staging database for tests?', options: ['Yes', 'No'] }
const TASK = { kind: 'task', ask: 'Sign in to the registry', steps: ['npm login'] }
const FINDING = { kind: 'finding', finding_kind: 'issue', title: 'Retry loop never backs off', detail: 'It hammers the API.' }

function memoryStorage(initial: unknown = null) {
  let saved = structuredClone(initial)
  return {
    async get(key: string) {
      return key === STATE_KEY ? structuredClone(saved) : null
    },
    async set(_key: string, value: unknown) {
      saved = structuredClone(value)
    },
    saved: () => saved as State,
  }
}

/** A tracker on one transcript, with a model that waits for `release()` on each run. */
function setup(storage = memoryStorage(), time = fakeClock(1000), file = { text: '' }) {
  const holds: (() => void)[] = []
  let runs = 0
  const model = async (): Promise<ModelResult> => {
    runs += 1
    await new Promise<void>(r => holds.push(r))
    const update = parseReply('NEW: decide | 1 | Keep the old colour scheme? | Yes / No | yes')
    assert.ok(update)
    return { ok: true, update, text: '', ms: 1 }
  }
  const tracker = createTracker({ storage, clock: time.clock, read: async () => Buffer.from(file.text), model })
  const answer = createAnswerer({
    state: () => tracker.state(),
    edit: (id, change) => tracker.edit(id, change),
    now: () => time.now(),
    planNote: async () => PLAN,
  })
  const send = (request: unknown) => answer(request)
  const call = async (type: 'record' | 'close', args: Record<string, unknown>) => text(await send({ type, sessionId: S, args }))
  const promptStart = async () => text(await send({ type: 'prompt-start', sessionId: S }))
  /** A turn lands in the transcript and its `done` arrives: the model run for it starts and waits. */
  const endTurn = async (n: number) => {
    file.text += turn(n)
    void tracker.done(T)
    await time.run()
  }
  const release = async () => {
    holds.shift()?.()
    await time.run()
  }
  const session = () => tracker.state().sessions[S]
  const items = () => session().ledger.items.map(i => ({ ask: i.ask, turn: i.turn, from: i.from }))
  return { tracker, storage, time, file, send, call, promptStart, endTurn, release, session, items, runs: () => runs }
}

function text(a: Answer): string {
  assert.ok('text' in a, `expected an answer, got ${JSON.stringify(a)}`)
  return a.text
}

describe('tool calls on the session ledger', () => {
  test('record answers as recordItem does, word for word, and saves the item', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    const expected = recordItem(ORCA, { ...t.session().ledger, turn: 1 }, QUESTION, t.time.now()).result
    assert.equal(await t.call('record', QUESTION), expected)
    assert.match(expected, /^Recorded\. The user sees it in the Agent Inbox panel/)
    assert.deepEqual(t.storage.saved().sessions[S].ledger.items.map(i => i.ask), [QUESTION.ask])
  })

  test('close answers with the result, and a finding records into findings', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.call('record', FINDING)
    const id = t.session().ledger.findings[0].id
    assert.equal(await t.call('close', { id, reason: 'fixed in this change' }), 'Closed the finding. Name it by what it says, never by its id.')
    assert.equal(await t.call('close', { id: 'i99', reason: 'gone' }), "Not closed: no open item or finding has the id i99. The open ones are listed beside the user's latest message.")
  })

  test('an unknown session or a bad request is a short error', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    assert.deepEqual(await t.send({ type: 'record', sessionId: 'nobody', args: QUESTION }), { error: 'unknown session' })
    assert.deepEqual(await t.send({ type: 'shout', sessionId: S }), { error: 'bad request' })
    assert.deepEqual(await t.send(null), { error: 'bad request' })
  })
})

test('a first-turn Codex record binds and saves the main thread before answering', async () => {
  const storage = memoryStorage()
  const time = fakeClock(1000)
  const tracker = createTracker({ storage, clock: time.clock, read: async () => null, model: async () => ({ ok: false, reason: 'failed', detail: '', ms: 0 }) })
  await tracker.start()
  const answer = createAnswerer({
    state: () => tracker.state(), edit: (id, change) => tracker.edit(id, change), now: time.now,
    planNote: async () => null,
    bindCodex: async (paneKey, threadId, codexHome, source) => {
      await tracker.track(null, threadId, { pane: { key: paneKey, codexHome, promptHookSeen: source === 'prompt' } })
      await tracker.edit(threadId, s => ({ ...s, activeTurn: 1 }))
    },
    bind: async (terminalId, threadId, paneKey) => { await tracker.bind(terminalId, threadId, paneKey) },
  })
  const result = await answer({ type: 'record', sessionId: 'thread-1', paneKey: 'pane-1', codexHome: '/codex', args: FINDING })
  assert.match(text(result), /^Recorded\./)
  assert.equal(tracker.state().panes['pane-1'].threadId, 'thread-1')
  assert.equal(storage.saved().sessions['thread-1'].ledger.findings[0].title, FINDING.title)
  assert.equal(storage.saved().sessions['thread-1'].activeTurn, 1)
  const terminalId = 'term_11111111-1111-4111-8111-111111111111'
  assert.deepEqual(await answer({ type: 'prompt-start', paneKey: 'pane-1', codexHome: '/codex', sessionId: 'thread-1', terminalId }), { text: '' })
  assert.deepEqual(tracker.state().terminals[terminalId], { sessionId: 'thread-1', paneKey: 'pane-1' })
})

test('a prompt matching a press sent to another thread in the same pane is blocked', async () => {
  const storage = memoryStorage()
  const tracker = createTracker({ storage, clock: fakeClock().clock, read: async () => null, model: async () => ({ ok: false, reason: 'failed', detail: '', ms: 0 }) })
  await tracker.start()
  await tracker.track(null, 'thread-old', { pane: { key: 'pane-1', codexHome: '/codex', promptHookSeen: true } })
  await tracker.edit('thread-old', s => ({ ...s, presses: { i1: { state: 'sending', kind: 'answer', answer: 'Yes', text: 'Re "Ship?": Yes', at: 1, paneKey: 'pane-1' } } }))
  await tracker.track(null, 'thread-new', { pane: { key: 'pane-1', codexHome: '/codex', promptHookSeen: true } })
  const answer = createAnswerer({ state: () => tracker.state(), edit: (id, change) => tracker.edit(id, change), now: () => 1, planNote: async () => null })
  assert.deepEqual(await answer({ type: 'inbox-text', sessionId: 'thread-new', paneKey: 'pane-1', prompt: 'Re "Ship?": Yes' }), { error: 'press sent for a different Codex thread' })
  await tracker.edit('thread-old', s => ({ ...s, presses: { i1: { ...s.presses.i1, state: 'undelivered' } } }))
  assert.deepEqual(await answer({ type: 'inbox-text', sessionId: 'thread-new', paneKey: 'pane-1', prompt: 'Re "Ship?": Yes' }), { error: 'press sent for a different Codex thread' })
  assert.ok('text' in await answer({ type: 'inbox-text', sessionId: 'thread-new', paneKey: 'pane-1', prompt: 'A new request' }))
})

test('notify reduction excludes a reply over one MiB and reads the top-level user command', () => {
  const request = notifyRequest({ type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-1', 'last-assistant-message': 'x'.repeat(1 << 20) }, { ORCA_PANE_KEY: 'pane-1', CODEX_HOME: '/codex' })
  assert.deepEqual(request, { type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: '/codex', threadId: 'thread-1', turnId: 'turn-1', type: 'agent-turn-complete' } })
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 1024)
  assert.deepEqual(notifyCommand('notify = ["echo", "hello"]\n[features]\nnotify = ["wrong"]\n'), ['echo', 'hello'])
  assert.deepEqual(notifyCommand("notify = ['echo', 'hello']\n"), ['echo', 'hello'])
  assert.equal(notifyCommand('[features]\nnotify = ["wrong"]\n'), null)
  assert.equal(notifyRequest({ 'thread-id': 'thread-1' }, { ORCA_PANE_KEY: 'pane-1' }), null, 'no account home is guessed')
})

test('a personal notify still runs when worker reporting has no pane key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-codex-home-'))
  const marker = join(home, 'payload.json')
  const script = join(home, 'capture.mjs')
  writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], process.argv[3]);\n")
  writeFileSync(join(home, 'config.toml'), `notify = [${[process.execPath, script, marker].map(x => JSON.stringify(x)).join(', ')}]\n`)
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread-1' })
  try {
    await runCodexNotify('/nonexistent/w.sock', payload, { CODEX_HOME: home })
    assert.equal(readFileSync(marker, 'utf8'), payload)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a first tool call with no account home still saves its pane and finding', async () => {
  const storage = memoryStorage()
  const time = fakeClock(1000)
  const tracker = createTracker({ storage, clock: time.clock, read: async () => null, model: async () => ({ ok: false, reason: 'failed', detail: '', ms: 0 }) })
  await tracker.start()
  const answer = createAnswerer({
    state: () => tracker.state(), edit: (id, change) => tracker.edit(id, change), now: time.now, planNote: async () => null,
    bindCodex: async (paneKey, threadId, codexHome) => tracker.track(null, threadId, { pane: { key: paneKey, codexHome, promptHookSeen: false } }),
  })
  const result = await answer({ type: 'record', paneKey: 'pane-1', sessionId: 'thread-1', codexHome: '', args: FINDING })
  assert.match(text(result), /^Recorded\./)
  assert.equal(tracker.state().panes['pane-1'].codexHome, '')
  assert.equal(storage.saved().sessions['thread-1'].ledger.findings[0].title, FINDING.title)
})

describe('the turn stamp (spec step 4)', () => {
  test('a call during the first turn carries turn 1', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    assert.equal(t.storage.saved().sessions[S].activeTurn, 1, 'saved before the answer')
    await t.call('record', QUESTION)
    assert.deepEqual(t.items(), [{ ask: QUESTION.ask, turn: 1, from: 'record' }])
    assert.equal(t.session().ledger.turn, 0, "the ledger keeps the transcript's count")
  })

  test('a call during a slow model run carries the turn that ended, and the run keeps it', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.endTurn(1)
    assert.equal(t.runs(), 1)
    await t.call('record', TASK)
    await t.release()
    assert.deepEqual(t.items(), [
      { ask: TASK.ask, turn: 1, from: 'record' },
      { ask: 'Keep the old colour scheme?', turn: 1, from: 'update' },
    ])
  })

  test('a prompt sent while a run is out stamps the next turn, and the commit does not lower it', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.endTurn(1)
    await t.promptStart()
    await t.call('record', QUESTION)
    await t.release()
    assert.equal(t.session().ledger.turn, 1)
    assert.equal(activeTurn(t.session()), 2)
    assert.deepEqual(t.items().find(i => i.ask === QUESTION.ask), { ask: QUESTION.ask, turn: 2, from: 'record' })
    await t.call('record', TASK)
    assert.equal(t.items().find(i => i.ask === TASK.ask)?.turn, 2)
  })

  test('a call after turn N commits and before turn N+1 starts carries N', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.endTurn(1)
    await t.release()
    await t.call('record', QUESTION)
    assert.equal(t.items().find(i => i.ask === QUESTION.ask)?.turn, 1)
  })

  test('the transcript catches the active turn up when prompts came without a prompt-start', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.endTurn(1)
    await t.release()
    await t.call('record', QUESTION)
    assert.equal(t.items()[1].turn, 1)
  })

  test('a worker restart between a call and the next turn keeps the item and the turn', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.call('record', QUESTION)
    const next = setup(memoryStorage(t.storage.saved()), t.time, t.file)
    await next.tracker.start()
    await next.promptStart()
    await next.call('record', TASK)
    assert.deepEqual(next.items(), [
      { ask: QUESTION.ask, turn: 1, from: 'record' },
      { ask: TASK.ask, turn: 2, from: 'record' },
    ])
  })
})

describe('inbox-text', () => {
  test('gives the inbox text, then the closed items, then the plan note, as the skill adds them', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.call('record', QUESTION)
    const id = t.session().ledger.items[0].id
    await t.call('close', { id, answer: 'Yes' })
    await t.promptStart()
    const first = text(await t.send({ type: 'inbox-text', sessionId: S, prompt: 'go on' }))
    const inbox = inboxText(ORCA, t.session().ledger, false)
    assert.equal(first, `${inbox}\nClosed since you last read the inbox:\n- "${QUESTION.ask}" → Yes\n\n${PLAN}`)
    // Told once: the same inbox and no new close add only the plan note.
    await t.promptStart()
    assert.equal(text(await t.send({ type: 'inbox-text', sessionId: S, prompt: 'and again' })), PLAN)
    assert.deepEqual(t.storage.saved().sessions[S].told.closed, [id])
  })

  test("the hook's cwd is saved as the session's folder when none is known, and a known one stays", async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.send({ type: 'prompt-start', sessionId: S, cwd: '/work/app' })
    assert.equal(t.session().cwd, '/work/app')
    await t.send({ type: 'inbox-text', sessionId: S, prompt: 'go', cwd: '/elsewhere' })
    assert.equal(t.session().cwd, '/work/app')
    const u = setup()
    await u.tracker.track(T, S)
    await u.send({ type: 'inbox-text', sessionId: S, prompt: 'go', cwd: '/work/app' })
    assert.equal(u.session().cwd, '/work/app', 'inbox-text alone saves it too')
  })

  test('with an open item the inbox lists it with its close id', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    await t.promptStart()
    await t.call('record', TASK)
    const out = text(await t.send({ type: 'inbox-text', sessionId: S }))
    assert.match(out, /Sign in to the registry.*\(close id: i\d+\)/)
    assert.ok(out.endsWith(PLAN))
  })
})

describe('the socket', () => {
  const dirs: string[] = []
  const servers: Server[] = []
  after(() => {
    for (const s of servers) s.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  /** A short folder: the socket path must stay under 104 bytes. */
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'oai-'))
    dirs.push(d)
    return d
  }

  test('socketPath is per user and short enough; binPaths are the plugin folder scripts', () => {
    const path = socketPath()
    assert.ok(Buffer.byteLength(path) <= 103)
    assert.ok(path.includes(`orca-agent-inbox-${process.getuid?.()}`))
    const bins = binPaths()
    assert.equal(bins.mcpServer, join(BIN, 'mcp-server.mjs'))
    assert.equal(bins.promptHook, join(BIN, 'prompt-hook.mjs'))
    assert.ok(existsSync(bins.mcpServer) && existsSync(bins.promptHook))
  })

  test('a round trip over the socket, which is 0600 in a 0700 folder, and a stale file is replaced', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    const path = join(tempDir(), 'run', 'w.sock')
    // A worker that stopped left its file behind: a plain file in the way.
    const first = await listen(path, async () => ({ text: 'first' }))
    await new Promise<void>(r => first.close(() => r()))
    writeFileSync(path, 'stale')
    const server = await listen(path, request => t.send(request))
    servers.push(server)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700)
    assert.deepEqual(await ask(path, { type: 'prompt-start', sessionId: S }, 2000), { text: '' })
    const recorded = await ask(path, { type: 'record', sessionId: S, args: QUESTION }, 2000)
    assert.match(recorded.text, /^Recorded\./)
    assert.deepEqual(await ask(path, { type: 'record', sessionId: 'nobody', args: QUESTION }, 2000), { error: 'unknown session' })
    assert.deepEqual(await ask(path, 'not json', 2000), { error: 'bad request' })
    assert.equal(t.items()[0].turn, 1)
  })

  test('a worker that closes after a new one listens on the same path leaves the new socket in place', async () => {
    const path = join(tempDir(), 'w.sock')
    const a = await listen(path, async () => ({ text: 'a' }))
    const b = await listen(path, async () => ({ text: 'b' }))
    servers.push(b)
    await new Promise<void>(r => a.close(() => r()))
    assert.equal(existsSync(path), true)
    assert.deepEqual(await ask(path, { type: 'prompt-start', sessionId: S }, 2000), { text: 'b' })
  })

  test('closing the server removes its file', async () => {
    const path = join(tempDir(), 'w.sock')
    const server = await listen(path, async () => ({ text: '' }))
    await new Promise<void>(r => server.close(() => r()))
    assert.equal(existsSync(path), false)
  })
})

describe('bin/tools.json', () => {
  test('is agentTools(ORCA), word for word', () => {
    const file = join(BIN, 'tools.json')
    if (process.env.UPDATE_TOOLS === '1') writeFileSync(file, `${JSON.stringify(agentTools(ORCA), null, 2)}\n`)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), agentTools(ORCA), 'run UPDATE_TOOLS=1 npm test')
  })
})

/** A fake worker socket: answers each request with `reply`, or never when it returns undefined. */
async function fakeSocket(reply: (request: Record<string, unknown>) => Answer | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'oai-'))
  const path = join(dir, 'w.sock')
  const requests: Record<string, unknown>[] = []
  const conns = new Set<import('node:net').Socket>()
  const server = createServer(conn => {
    conns.add(conn)
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', () => undefined)
    conn.on('data', (chunk: string) => {
      buf += chunk
      if (!buf.includes('\n')) return
      const request = JSON.parse(buf.slice(0, buf.indexOf('\n')))
      requests.push(request)
      const answer = reply(request)
      if (answer) conn.end(`${JSON.stringify(answer)}\n`)
    })
  })
  await new Promise<void>(r => server.listen(path, r))
  const close = async () => {
    for (const c of conns) c.destroy()
    await new Promise<void>(r => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  }
  return { path, requests, close }
}

/** Runs a bin script with these lines on stdin, and gives what it printed once it exits. */
function run(script: string, args: string[], input: string, opts: { keepOpen?: boolean; handle?: string; env?: Record<string, string> } = {}) {
  // A test run inside an Orca terminal inherits its handle: each run sets its own.
  const { ORCA_TERMINAL_HANDLE: _, ...env } = process.env
  const child = spawn(process.execPath, [join(BIN, script), ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...(opts.handle ? { ORCA_TERMINAL_HANDLE: opts.handle } : {}), ...opts.env } })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
  child.stdin.write(input)
  if (!opts.keepOpen) child.stdin.end()
  const exited = new Promise<{ code: number | null; out: string }>(r => child.on('exit', code => r({ code, out })))
  return { child, exited, out: () => out, err: () => err }
}

/** Sends JSON-RPC lines to the MCP server and reads answers until `count` came back. */
async function mcp(socket: string, messages: unknown[], count: number, timeout = 5000, env?: Record<string, string>) {
  const r = run('mcp-server.mjs', ['--socket', socket, ...(env ? [] : ['--session', S]), '--timeout', String(timeout)], messages.map(m => `${JSON.stringify(m)}\n`).join(''), { keepOpen: true, env })
  const deadline = Date.now() + 10_000
  while (r.out().split('\n').filter(Boolean).length < count && Date.now() < deadline) await new Promise(res => setTimeout(res, 20))
  r.child.stdin.end()
  await r.exited
  return r.out().split('\n').filter(Boolean).map(line => JSON.parse(line)).sort((x, y) => x.id - y.id)
}

describe('bin/mcp-server.mjs', () => {
  test('Codex binds only the main thread; sub-agent calls never reach the main ledger', async () => {
    const sock = await fakeSocket(req => ({ text: `answer to ${req.type}` }))
    try {
      const env = { ORCA_PANE_KEY: 'pane-1', CODEX_HOME: '/codex' }
      const meta = (source: string) => ({ threadId: source === 'user' ? 'thread-1' : 'sub-1', 'x-codex-turn-metadata': { thread_source: source } })
      const answers = await mcp(sock.path, [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record', arguments: FINDING, _meta: meta('user') } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'record', arguments: FINDING, _meta: meta('subagent') } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'close', arguments: { id: 'i1', reason: 'fixed' } } },
      ], 3, 2000, env)
      assert.equal(answers[0].result.isError, undefined)
      assert.equal(answers[1].result.isError, true)
      assert.equal(answers[2].result.isError, undefined, 'missing metadata still gets an answer')
      assert.deepEqual(sock.requests, [
        { type: 'record', paneKey: 'pane-1', codexHome: '/codex', codexTurnId: '', sessionId: 'thread-1', args: FINDING },
        { type: 'close', paneKey: 'pane-1', codexHome: '/codex', codexTurnId: '', args: { id: 'i1', reason: 'fixed' } },
      ])
    } finally {
      await sock.close()
    }
  })

  test('initialize, tools/list and tools/call over stdio', async () => {
    const sock = await fakeSocket(req => ({ text: `answer to ${req.type}` }))
    try {
      const answers = await mcp(
        sock.path,
        [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'record', arguments: QUESTION } },
          { jsonrpc: '2.0', id: 4, method: 'nope' },
        ],
        4,
      )
      const byId = new Map(answers.map(a => [a.id, a]))
      assert.equal(answers.length, 4, 'the notification gets no answer')
      assert.deepEqual(byId.get(1).result, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orca-inbox', version: '0.1.0' } })
      assert.deepEqual(byId.get(2).result.tools, agentTools(ORCA))
      assert.deepEqual(byId.get(3).result, { content: [{ type: 'text', text: 'answer to record' }] })
      assert.equal(byId.get(4).error.code, -32601)
      assert.deepEqual(sock.requests, [{ type: 'record', sessionId: S, args: QUESTION }])
    } finally {
      await sock.close()
    }
  })

  test('a worker that never answers gives "not available" after the timeout', async () => {
    const sock = await fakeSocket(() => undefined)
    try {
      const started = Date.now()
      const [answer] = await mcp(sock.path, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'close', arguments: { id: 'i1', reason: 'done' } } }], 1, 300)
      assert.ok(Date.now() - started >= 300)
      assert.deepEqual(answer.result, { content: [{ type: 'text', text: 'The inbox is not available, so this was not saved.' }], isError: true })
    } finally {
      await sock.close()
    }
  })

  test('a missing socket or an error answer gives "not available" at once', async () => {
    const [missing] = await mcp('/nonexistent/w.sock', [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record', arguments: QUESTION } }], 1)
    assert.equal(missing.result.isError, true)
    const sock = await fakeSocket(() => ({ error: 'unknown session' }))
    try {
      const [answer] = await mcp(sock.path, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record', arguments: QUESTION } }], 1)
      assert.equal(answer.result.content[0].text, 'The inbox is not available, so this was not saved.')
    } finally {
      await sock.close()
    }
  })
})

describe('bin/prompt-hook.mjs', () => {
  const hookInput = (over: Record<string, unknown> = {}) => JSON.stringify({ session_id: S, hook_event_name: 'UserPromptSubmit', prompt: 'carry on', cwd: '/work/app', ...over })

  test('Codex exits 2 when the worker identifies a press for another thread', async () => {
    const sock = await fakeSocket(req => req.type === 'prompt-start' ? { text: '' } : { error: 'press sent for a different Codex thread' })
    try {
      const runHook = run('prompt-hook.mjs', ['--socket', sock.path], hookInput(), { env: { ORCA_PANE_KEY: 'pane-1', CODEX_HOME: '/codex' } })
      const result = await runHook.exited
      assert.equal(result.code, 2)
      assert.equal(result.out, '')
      assert.match(runHook.err(), /press belongs to another Codex thread/)
    } finally {
      await sock.close()
    }
  })

  test('Codex stdin binds the pane before printing text, while agent_id is ignored', async () => {
    const sock = await fakeSocket(req => (req.type === 'prompt-start' ? { text: '' } : { text: 'Open inbox items' }))
    try {
      const env = { ORCA_PANE_KEY: 'pane-1', CODEX_HOME: '/codex' }
      const transcript_path = `/codex/sessions/2026/11/05/rollout-2026-11-05-${S}.jsonl`
      const input = hookInput({ transcript_path })
      const { code, out } = await run('prompt-hook.mjs', ['--socket', sock.path], input, { env }).exited
      assert.equal(code, 0)
      assert.equal(out, 'Open inbox items\n')
      assert.deepEqual(sock.requests, [
        { type: 'prompt-start', sessionId: S, cwd: '/work/app', paneKey: 'pane-1', codexHome: '/codex', codexTurnId: '' },
        { type: 'inbox-text', sessionId: S, prompt: 'carry on', cwd: '/work/app', paneKey: 'pane-1', codexHome: '/codex', codexTurnId: '' },
      ])
      await run('prompt-hook.mjs', ['--socket', sock.path], hookInput({ transcript_path, agent_id: 'sub-agent' }), { env }).exited
      await run('prompt-hook.mjs', ['--socket', sock.path], hookInput({ transcript_path, agent_id: '' }), { env }).exited
      assert.equal(sock.requests.length, 2)
    } finally {
      await sock.close()
    }
  })

  test('sends prompt-start, then inbox-text, and prints the text', async () => {
    const sock = await fakeSocket(req => (req.type === 'prompt-start' ? { text: '' } : { text: 'inbox: what waits on the user' }))
    try {
      const { code, out } = await run('prompt-hook.mjs', ['--socket', sock.path, '--session', S], hookInput()).exited
      assert.equal(code, 0)
      assert.equal(out, 'inbox: what waits on the user\n')
      assert.deepEqual(sock.requests, [
        { type: 'prompt-start', sessionId: S, cwd: '/work/app' },
        { type: 'inbox-text', sessionId: S, prompt: 'carry on', cwd: '/work/app' },
      ])
    } finally {
      await sock.close()
    }
  })

  test("sends the terminal's ORCA_TERMINAL_HANDLE on prompt-start", async () => {
    const sock = await fakeSocket(() => ({ text: '' }))
    try {
      const handle = 'term_0f0f0f0f-1111-4222-8333-444444444444'
      await run('prompt-hook.mjs', ['--socket', sock.path, '--session', S], hookInput(), { handle }).exited
      assert.deepEqual(sock.requests[0], { type: 'prompt-start', sessionId: S, cwd: '/work/app', terminalId: handle })
    } finally {
      await sock.close()
    }
  })

  test('a worker that never answers: prints nothing and exits 0 after the timeout', async () => {
    const sock = await fakeSocket(() => undefined)
    try {
      const started = Date.now()
      const { code, out } = await run('prompt-hook.mjs', ['--socket', sock.path, '--session', S, '--timeout', '300'], hookInput()).exited
      assert.ok(Date.now() - started < 4000)
      assert.equal(code, 0)
      assert.equal(out, '')
    } finally {
      await sock.close()
    }
  })

  test('another session (after /clear), a missing socket or an error answer: prints nothing and exits 0', async () => {
    const sock = await fakeSocket(() => ({ error: 'unknown session' }))
    try {
      const other = await run('prompt-hook.mjs', ['--socket', sock.path, '--session', S], hookInput({ session_id: 'session-2' })).exited
      assert.deepEqual(other, { code: 0, out: '' })
      assert.deepEqual(sock.requests, [])
      const failed = await run('prompt-hook.mjs', ['--socket', sock.path, '--session', S], hookInput()).exited
      assert.deepEqual(failed, { code: 0, out: '' })
      const missing = await run('prompt-hook.mjs', ['--socket', '/nonexistent/w.sock', '--session', S], hookInput()).exited
      assert.deepEqual(missing, { code: 0, out: '' })
    } finally {
      await sock.close()
    }
  })
})

test('Codex notify waits at most five seconds for the worker, then runs the user notify with the original payload', async () => {
  const sock = await fakeSocket(() => undefined)
  const home = mkdtempSync(join(tmpdir(), 'inbox-codex-home-'))
  const marker = join(home, 'payload.json')
  const script = join(home, 'capture.mjs')
  writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], process.argv[3]);\n")
  writeFileSync(join(home, 'config.toml'), `notify = [${[process.execPath, script, marker].map(x => JSON.stringify(x)).join(', ')}]\n`)
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-1', 'last-assistant-message': 'private reply' })
  try {
    const start = Date.now()
    const result = await run('codex-notify.mjs', [sock.path, payload], '', { env: { ORCA_PANE_KEY: 'pane-1', CODEX_HOME: home } }).exited
    const elapsed = Date.now() - start
    assert.equal(result.code, 0)
    assert.ok(elapsed >= 4900 && elapsed < 9000, `notify waited ${elapsed}ms`)
    assert.deepEqual(sock.requests, [{ type: 'codex-turn', payload: { paneKey: 'pane-1', codexHome: home, threadId: 'thread-1', turnId: 'turn-1', type: 'agent-turn-complete' } }])
    assert.equal(readFileSync(marker, 'utf8'), payload)
  } finally {
    await sock.close()
    rmSync(home, { recursive: true, force: true })
  }
})
