// The turn tracker with a fake clock, a fake transcript, fake storage and a fake model (plan T4).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { EMPTY, parseReply } from './core/ledger'
import { readCodexTurn } from './core/codex-transcript'
import type { ModelResult } from './model'
import { STATE_KEY, emptySession, upgradeState, type State } from './state'
import { LIMIT_MS, createTracker, screenFor, type Clock } from './turns'

const S = 'session-1'
const T = 'terminal-1'

// Hand-written lines in the shapes of src/fixtures/plain.jsonl.
const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, isSidechain: false, origin: { kind: 'human' }, turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'
const turn = (n: number) => prompt(`p-${n}`, `Prompt ${n}`) + reply(`a-${n}`, `Reply ${n}.`)

/** Unlike asks, so the ledger never merges two of them: each model run that is applied adds one item. */
const ASKS = [
  'Ship the parser today?',
  'Rename the folder to tools?',
  'Keep the old colour scheme?',
  'Delete stale branches now?',
  'Upgrade node before Friday?',
  'Publish release notes publicly?',
  'Move billing onto Stripe?',
  'Translate docs into Spanish?',
]

function fakeClock() {
  let t = 0
  const timers: { at: number; wake: () => void }[] = []
  const clock: Clock = {
    now: () => t,
    sleep: ms => new Promise(wake => timers.push({ at: t + ms, wake })),
  }
  /** Runs every task and timer up to `until`, as time passes. */
  async function run(until = Infinity): Promise<void> {
    for (;;) {
      for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r))
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) {
        if (until !== Infinity) t = Math.max(t, until)
        return
      }
      timers.shift()
      t = next.at
      next.wake()
    }
  }
  return { clock, run, now: () => t }
}

/** Storage that can die: before a write lands (`crashBefore`) or just after (`crashAfter`). After that, writes never finish. */
function fakeStorage(initial?: unknown) {
  let saved: unknown = initial === undefined ? null : structuredClone(initial)
  let dead = false
  const store = {
    crashBefore: null as null | ((s: State) => boolean),
    crashAfter: null as null | ((s: State) => boolean),
    async get(key: string) {
      return key === STATE_KEY ? structuredClone(saved) : null
    },
    set(key: string, value: unknown): Promise<void> {
      assert.equal(key, STATE_KEY)
      if (dead || store.crashBefore?.(value as State)) {
        dead = true
        return new Promise(() => undefined)
      }
      saved = structuredClone(value)
      if (store.crashAfter?.(value as State)) {
        dead = true
        return new Promise(() => undefined)
      }
      return Promise.resolve()
    },
    saved: () => saved as State,
  }
  return store
}

type How = 'ok' | 'failed' | 'timeout' | 'hold' | 'hang'

/** A model that answers each run with the next ask. `script` sets each run's outcome; the rest are 'ok'. */
function fakeModel(script: How[] = [], counter = { runs: 0 }) {
  const calls: { prompt: string; source: string }[] = []
  const holds: (() => void)[] = []
  let active = 0
  let maxActive = 0
  async function model(promptText: string, source: string): Promise<ModelResult> {
    const run = counter.runs++
    const how = script[calls.length] ?? 'ok'
    calls.push({ prompt: promptText, source })
    active += 1
    maxActive = Math.max(maxActive, active)
    if (how === 'hold') await new Promise<void>(r => holds.push(r))
    if (how === 'hang') await new Promise(() => undefined)
    active -= 1
    if (how === 'failed') return { ok: false, reason: 'failed', detail: 'model failed', ms: 1 }
    if (how === 'timeout') return { ok: false, reason: 'timeout', detail: 'no answer in 45000 ms', ms: 45_000 }
    const update = parseReply(`NEW: decide | 1 | ${ASKS[run]} | Yes / No | yes`)
    assert.ok(update)
    return { ok: true, update, text: '', ms: 1 }
  }
  return { model, calls, release: () => holds.shift()?.(), maxActive: () => maxActive }
}

function setup(opts: { file?: () => string | null; storage?: ReturnType<typeof fakeStorage>; model?: ReturnType<typeof fakeModel>; time?: ReturnType<typeof fakeClock> } = {}) {
  const time = opts.time ?? fakeClock()
  const storage = opts.storage ?? fakeStorage()
  const model = opts.model ?? fakeModel()
  const files = { text: null as string | null }
  const read = async () => {
    const text = opts.file ? opts.file() : files.text
    return text === null ? null : Buffer.from(text)
  }
  const tracker = createTracker({ storage, clock: time.clock, read, model: model.model })
  return { tracker, storage, model, time, files }
}

/** A tracker started fresh on what the crashed one saved, reading the same file. */
async function restart(old: ReturnType<typeof setup>, model = fakeModel()) {
  const next = setup({ storage: fakeStorage(old.storage.saved()), model, time: old.time, file: () => old.files.text })
  await next.tracker.start()
  await next.time.run()
  return next
}

const asks = (s: State) => s.sessions[S].ledger.items.map(i => i.ask)

describe('turn tracker', () => {
  test("track keeps the launch's tools mark: a relaunch with tools clears it, one that says nothing keeps it", async () => {
    const t = setup()
    await t.tracker.track(T, S, { tools: false })
    assert.equal(t.tracker.state().sessions[S].tools, false)
    await t.tracker.track(T, S)
    assert.equal(t.tracker.state().sessions[S].tools, false)
    await t.tracker.track(T, S, { tools: true })
    assert.equal(t.tracker.state().sessions[S].tools, true)
  })

  test('a done before the file is written reads the turn once it lands', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    void t.tracker.done(T)
    await t.time.run(3000)
    assert.equal(t.model.calls.length, 0)
    t.files.text = turn(1)
    await t.time.run()
    const saved = t.storage.saved()
    assert.equal(t.model.calls.length, 1)
    assert.deepEqual(asks(saved), [ASKS[0]])
    assert.equal(saved.sessions[S].offset, turn(1).length)
    assert.equal(saved.sessions[S].lastTurnId, 'p-1')
    assert.deepEqual(saved.sessions[S].queue, [])
  })

  test('a complete turn waits until the file has not grown for 2 s', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    t.files.text = prompt('p-1', 'Prompt 1') + reply('a-1', 'First part.')
    void t.tracker.done(T)
    await t.time.run(1000)
    t.files.text += reply('a-2', 'Second part.')
    await t.time.run(2500)
    assert.equal(t.model.calls.length, 0, 'the growth at 1 s restarts the 2 s wait')
    await t.time.run()
    assert.equal(t.model.calls.length, 1)
    assert.match(t.model.calls[0].prompt, /First part\.\n\nSecond part\./)
  })

  test('a repeated done with no new text does nothing', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    t.files.text = turn(1)
    void t.tracker.done(T)
    await t.time.run()
    const before = t.storage.saved()
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 1)
    assert.deepEqual(t.storage.saved(), before)
  })

  test('two overlapping dones run the model one turn at a time, in order', async () => {
    const t = setup({ model: fakeModel(['hold', 'ok']) })
    await t.tracker.track(T, S)
    t.files.text = turn(1)
    void t.tracker.done(T)
    await t.time.run(3000)
    assert.equal(t.model.calls.length, 1)
    t.files.text += turn(2)
    void t.tracker.done(T)
    await t.time.run(6000)
    // The second turn is saved while the first one's model run is still out.
    assert.deepEqual(t.storage.saved().sessions[S].queue.map(q => q.turnId), ['p-1', 'p-2'])
    assert.equal(t.model.calls.length, 1)
    t.model.release()
    await t.time.run()
    assert.equal(t.model.maxActive(), 1)
    assert.equal(t.model.calls.length, 2)
    assert.match(t.model.calls[1].prompt, /Prompt 2/)
    const saved = t.storage.saved()
    assert.deepEqual(asks(saved), [ASKS[0], ASKS[1]])
    assert.equal(saved.sessions[S].offset, t.files.text.length)
    assert.equal(saved.sessions[S].lastTurnId, 'p-2')
  })

  test('a done during a poll extends it to 15 s after the later done', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    void t.tracker.done(T)
    await t.time.run(10_000)
    void t.tracker.done(T)
    await t.time.run(20_000)
    t.files.text = turn(1)
    await t.time.run()
    assert.equal(t.model.calls.length, 1, 'the poll still reads at 20 s, before 10 s + 15 s')
    assert.ok(t.time.now() <= 10_000 + LIMIT_MS + 1000)
  })

  test('an incomplete turn goes to the model with an empty reply, then the complete one', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    t.files.text = prompt('p-1', 'Prompt 1') + turn(2)
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 2)
    assert.match(t.model.calls[0].prompt, /<person>\nPrompt 1\n<\/person>/)
    assert.match(t.model.calls[0].prompt, /<reply>\n\n<\/reply>/)
    assert.match(t.model.calls[1].prompt, /Reply 2\./)
    const saved = t.storage.saved()
    assert.equal(saved.sessions[S].offset, t.files.text.length)
    assert.equal(saved.sessions[S].ledger.turn, 2)
  })

  test('a turn still pending at 15 s stays unread until the next done', async () => {
    const t = setup()
    await t.tracker.track(T, S)
    t.files.text = prompt('p-1', 'Prompt 1')
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 0)
    assert.equal(t.storage.saved().sessions[S].offset, 0)
    t.files.text += reply('a-1', 'Reply 1.')
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 1)
  })

  test('the screen names the panel and whether it lists rows', async () => {
    assert.match(screenFor(EMPTY), /Agent Inbox panel .* is closed\./)
    const t = setup()
    await t.tracker.track(T, S)
    t.files.text = turn(1)
    void t.tracker.done(T)
    await t.time.run()
    t.files.text += turn(2)
    void t.tracker.done(T)
    await t.time.run()
    assert.match(t.model.calls[0].prompt, /<screen>\n.* is closed\.\n<\/screen>/)
    assert.match(t.model.calls[1].prompt, /<screen>\n.* is open beside the conversation, listing every open item\.\n<\/screen>/)
  })

  test('a crash after the queue write: a restart applies each turn once', async () => {
    const t = setup({ model: fakeModel(['hang']) })
    t.storage.crashAfter = s => s.sessions[S]?.queue.length > 0
    await t.tracker.track(T, S)
    t.files.text = turn(1) + turn(2)
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 0, 'the crash comes before the model runs')
    assert.deepEqual(t.storage.saved().sessions[S].queue.map(q => q.turnId), ['p-1'])

    const counter = { runs: 0 }
    const r = await restart(t, fakeModel([], counter))
    assert.equal(r.model.calls.length, 2)
    const saved = r.storage.saved()
    assert.deepEqual(asks(saved), [ASKS[0], ASKS[1]])
    assert.equal(saved.sessions[S].offset, t.files.text.length)
    assert.equal(saved.sessions[S].lastTurnId, 'p-2')

    const again = await restart(r, fakeModel([], counter))
    assert.equal(again.model.calls.length, 0)
    assert.deepEqual(asks(again.storage.saved()), [ASKS[0], ASKS[1]])
  })

  test('a crash after the model answers, before the commit write: a restart applies each turn once', async () => {
    const counter = { runs: 0 }
    const t = setup({ model: fakeModel([], counter) })
    t.storage.crashBefore = s => s.sessions[S]?.lastTurnId === 'p-2'
    await t.tracker.track(T, S)
    t.files.text = turn(1) + turn(2)
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 2)
    const crashed = t.storage.saved()
    assert.equal(crashed.sessions[S].lastTurnId, 'p-1')
    assert.deepEqual(crashed.sessions[S].queue.map(q => q.turnId), ['p-2'])
    assert.deepEqual(asks(crashed), [ASKS[0]])

    const r = await restart(t, fakeModel([], counter))
    assert.equal(r.model.calls.length, 1)
    assert.match(r.model.calls[0].prompt, /Prompt 2/)
    const saved = r.storage.saved()
    // Turn 2's lost answer (ASKS[1]) is gone; its rerun (ASKS[2]) is applied once.
    assert.deepEqual(asks(saved), [ASKS[0], ASKS[2]])
    assert.equal(saved.sessions[S].offset, t.files.text.length)
    assert.deepEqual(saved.sessions[S].queue, [])

    const again = await restart(r, fakeModel([], counter))
    assert.equal(again.model.calls.length, 0)
  })

  test('a turn whose id is lastTurnId is never applied again', async () => {
    const queued = { turnId: 'p-1', exchange: { person: 'Prompt 1', trigger: null, activity: [], reply: 'Reply 1.', turn: 1, press: null, screen: '' }, nextOffset: turn(1).length, failures: 0 }
    const storage = fakeStorage({ version: 1, terminals: {}, sessions: { [S]: { ...emptySession(), lastTurnId: 'p-1', queue: [queued] } } })
    const t = setup({ storage })
    await t.tracker.start()
    await t.time.run()
    assert.equal(t.model.calls.length, 0)
    assert.deepEqual(storage.saved().sessions[S].queue, [])
    assert.equal(storage.saved().sessions[S].offset, turn(1).length)
  })

  test('a model that times out 3 times: retried at the next done and at start, then dropped and counted', async () => {
    const t = setup({ model: fakeModel(['timeout', 'timeout']) })
    await t.tracker.track(T, S)
    t.files.text = turn(1)
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 1, 'a failure waits for the next done')
    assert.equal(t.storage.saved().sessions[S].queue[0].failures, 1)

    t.files.text += turn(2)
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.model.calls.length, 2, 'the done retries turn 1; turn 2 waits behind it')
    assert.deepEqual(t.storage.saved().sessions[S].queue.map(q => [q.turnId, q.failures]), [['p-1', 2], ['p-2', 0]])

    const r = await restart(t, fakeModel(['timeout']))
    assert.equal(r.model.calls.length, 2, 'the third failure drops turn 1, then turn 2 runs')
    assert.match(r.model.calls[1].prompt, /Prompt 2/)
    const saved = r.storage.saved()
    assert.equal(saved.sessions[S].unread, 1)
    assert.equal(saved.sessions[S].lastTurnId, 'p-2')
    assert.deepEqual(saved.sessions[S].queue, [])
    assert.equal(saved.sessions[S].offset, t.files.text.length)
    assert.equal(asks(saved).length, 1)
  })
})

describe('upgradeState', () => {
  test('upgrades older state and keeps only valid Codex pane records', () => {
    const old = upgradeState({ version: 1, terminals: { t: { sessionId: 's' } }, sessions: { s: {} } })
    assert.equal(old.version, 3)
    assert.deepEqual(old.panes, {})
    assert.ok(old.sessions.s)
    const current = upgradeState({ ...old, panes: {
      good: { agent: 'codex', threadId: 'thread-1', codexHome: '/codex', promptHookSeen: true },
      bad: { agent: 'codex', threadId: 4, codexHome: '/codex' },
    } })
    assert.deepEqual(current.panes, { good: { agent: 'codex', threadId: 'thread-1', codexHome: '/codex', promptHookSeen: true } })
    assert.deepEqual(current.paneLaunches, {})
    assert.equal(old.moved, undefined, 'state saved before Claude aliases still loads')
  })

  test('a version 2 Codex binding survives upgrade with an empty launch history', () => {
    const state = upgradeState({ version: 2, terminals: { t: { sessionId: 'thread-1', paneKey: 'pane-1' } },
      sessions: { 'thread-1': { agent: 'codex' } },
      panes: { 'pane-1': { agent: 'codex', threadId: 'thread-1', codexHome: '/codex', promptHookSeen: true } } })
    assert.equal(state.version, 3)
    assert.deepEqual(state.terminals.t, { sessionId: 'thread-1', paneKey: 'pane-1' })
    assert.equal(state.panes['pane-1'].threadId, 'thread-1')
    assert.deepEqual(state.paneLaunches, {})
  })

  test('drops saved Codex notify/done pairing fields', () => {
    const state = upgradeState({ version: 2, terminals: {}, panes: {}, sessions: { s: {
      agent: 'codex', codexNotified: ['turn-1'], codexDones: 2, codexLastDone: true,
    } } })
    assert.equal('codexNotified' in state.sessions.s, false)
    assert.equal('codexDones' in state.sessions.s, false)
    assert.equal('codexLastDone' in state.sessions.s, false)
  })

  test('a missing or unreadable value is the empty state', () => {
    assert.deepEqual(upgradeState(null), { version: 3, terminals: {}, sessions: {}, panes: {}, paneLaunches: {} })
    assert.deepEqual(upgradeState('x'), { version: 3, terminals: {}, sessions: {}, panes: {}, paneLaunches: {} })
  })

  test('fills fields a session saved without', () => {
    const s = upgradeState({ version: 1, terminals: { t: { sessionId: 's' }, bad: {} }, sessions: { s: { offset: 9, queue: [{ turnId: 'p', exchange: {}, nextOffset: 12 }, { bad: true }] } } })
    assert.deepEqual(Object.keys(s.terminals), ['t'])
    assert.equal(s.sessions.s.offset, 9)
    assert.deepEqual(s.sessions.s.queue.map(q => [q.turnId, q.failures]), [['p', 0]])
    assert.deepEqual(s.sessions.s.ledger, EMPTY)
    assert.equal(s.sessions.s.unread, 0)
    assert.equal(s.sessions.s.lastTurnId, null)
    assert.equal(s.sessions.s.tools, true, 'a session saved before launches kept tools shows no "No tools" note')
  })

  test("keeps a session's no-tools mark and the finding press kinds; an unknown kind reads as an answer", () => {
    const label = (kind: string) => ({ state: 'held', kind, answer: 'Fix', text: 'x', at: 1 })
    const s = upgradeState({ version: 1, terminals: {}, sessions: { s: { tools: false, presses: { a: label('fix'), b: label('issue'), c: label('odd') } } } })
    assert.equal(s.sessions.s.tools, false)
    assert.deepEqual(Object.values(s.sessions.s.presses).map(l => l.kind), ['fix', 'issue', 'answer'])
  })

  test("a terminal saved with a launch workspaceId keeps only its session; a session saved before transcript and cwd finds them again", () => {
    const s = upgradeState({ version: 1, terminals: { t: { sessionId: 's', workspaceId: 'repo::/work/app' } }, sessions: { s: {} } })
    assert.deepEqual(s.terminals, { t: { sessionId: 's' } })
    assert.deepEqual([s.sessions.s.transcript, s.sessions.s.cwd], [null, null])
  })

  test('a saved state reads back unchanged', () => {
    const s: State = {
      version: 1,
      terminals: { t: { sessionId: 's' } },
      sessions: { s: { ...emptySession(), offset: 4, lastTurnId: 'p', unread: 2, transcript: '/h/.claude/projects/-w/s.jsonl', cwd: '/w' } },
    }
    assert.deepEqual(upgradeState(JSON.parse(JSON.stringify(s))), { ...s, version: 3, panes: {}, paneLaunches: {} })
  })
})

const codexOne = () => readFileSync(new URL('./core/fixtures/codex-one.jsonl', import.meta.url))
const codexThree = () => readFileSync(new URL('./core/fixtures/codex-three.jsonl', import.meta.url))

function codexSetup(initial: Buffer | null = codexOne(), script: How[] = [], storage = fakeStorage()) {
  const time = fakeClock()
  const model = fakeModel(script)
  const file = { bytes: initial }
  const tracker = createTracker({
    storage, clock: time.clock,
    read: async () => file.bytes,
    codexTurn: async (_sessionId, offset) => file.bytes ? readCodexTurn(file.bytes, offset) : null,
    model: model.model,
  })
  return { tracker, storage, time, model, file }
}

async function codexTrack(t: ReturnType<typeof codexSetup>, home = '/codex') {
  await t.tracker.start()
  await t.tracker.track(T, S, { pane: { key: 'pane-1', codexHome: home, promptHookSeen: false } })
}

describe('Codex turns use the durable queue', () => {
  test('an interrupted turn and the next complete turn both reach the model, first with an empty reply', async () => {
    const lines = codexThree().toString('utf8').split('\n').filter(Boolean)
    const file = Buffer.from(lines.slice(0, 10).filter(line => !line.includes('"task_complete","turn_id":"turn-1"')).join('\n') + '\n')
    const t = codexSetup(file)
    await codexTrack(t)
    await t.tracker.codexNotify(S, 'turn-2')
    await t.time.run()
    assert.equal(t.model.calls.length, 2)
    assert.match(t.model.calls[0].prompt, /<person>\nWhat is here\?\n<\/person>/)
    assert.match(t.model.calls[0].prompt, /<reply>\n\n<\/reply>/)
    assert.match(t.model.calls[1].prompt, /<reply>\nAll tests passed\.\n<\/reply>/)
    assert.equal(t.storage.saved().sessions[S].lastTurnId, 'turn-2')
    assert.equal(t.storage.saved().sessions[S].ledger.turn, 2)
  })

  for (const order of ['notify first', 'done first'] as const) {
    test(`one ${order === 'notify first' ? 'notify' : 'done'} signal reads a complete rollout turn`, async () => {
      const t = codexSetup()
      await codexTrack(t)
      if (order === 'notify first') await t.tracker.codexNotify(S, 'turn-1')
      else await t.tracker.codexStatus(S, true)
      await t.time.run()
      assert.equal(t.model.calls.length, 1)
      assert.equal(t.storage.saved().sessions[S].lastTurnId, 'turn-1')
      assert.deepEqual(t.storage.saved().sessions[S].queue, [])
    })
  }

  test('a delayed duplicate notify after two turns cannot block turn three across a restart', async () => {
    const storage = fakeStorage()
    const lines = codexThree().toString('utf8').split('\n').filter(Boolean)
    const first = codexSetup(Buffer.from(lines.slice(0, 10).join('\n') + '\n'), [], storage)
    await codexTrack(first)
    await first.tracker.codexNotify(S, 'turn-1')
    await first.time.run()
    assert.equal(storage.saved().sessions[S].lastTurnId, 'turn-2')
    const resumed = codexSetup(Buffer.from(lines.join('\n') + '\n'), [], storage)
    await resumed.tracker.start()
    await resumed.tracker.codexNotify(S, 'turn-1')
    await resumed.time.run()
    assert.equal(resumed.model.calls.length, 1)
    assert.equal(storage.saved().sessions[S].lastTurnId, 'turn-3')
    assert.equal(storage.saved().sessions[S].ledger.turn, 3)
  })

  test('an unverified notify survives restart without done pairing state', async () => {
    const storage = fakeStorage()
    const first = codexSetup(null, [], storage)
    await codexTrack(first)
    await first.tracker.stageCodex('pane-other', 'thread-other', '/codex', 'turn-other')
    const restarted = codexSetup(null, [], storage)
    await restarted.tracker.start()
    assert.equal(restarted.tracker.state().pendingCodex?.['pane-other']?.[0].turnId, 'turn-other')
    await restarted.tracker.clearStagedCodex('pane-other', 'thread-other', 'turn-other')
    assert.equal(upgradeState(storage.saved()).pendingCodex, undefined)
  })

  test('a notify retries when its rollout appears later', async () => {
    const t = codexSetup(null)
    await codexTrack(t)
    await t.tracker.codexNotify(S, 'turn-1')
    await t.time.run()
    t.file.bytes = codexOne()
    t.tracker.retryCodex(S)
    await t.time.run()
    assert.equal(t.storage.saved().sessions[S].lastTurnId, 'turn-1')
  })

  test('a turn without task_complete never enters the queue', async () => {
    const lines = codexOne().toString('utf8').split('\n').filter(Boolean)
    const t = codexSetup(Buffer.from(lines.slice(0, -1).join('\n') + '\n'))
    await codexTrack(t)
    await t.tracker.codexNotify(S, 'turn-1')
    await t.time.run()
    assert.equal(t.model.calls.length, 0)
    t.file.bytes = codexOne()
    t.tracker.retryCodex(S)
    await t.time.run()
    assert.equal(t.model.calls.length, 1)
  })

  test('four Codex model timeouts keep the same queued turn and do not count as failures', async () => {
    const t = codexSetup(codexOne(), ['timeout', 'timeout', 'timeout', 'timeout'])
    await codexTrack(t)
    await t.tracker.codexNotify(S, 'turn-1')
    await t.tracker.codexStatus(S, true)
    await t.time.run()
    for (let run = 1; run < 5; run++) {
      assert.equal(t.model.calls.length, run)
      assert.deepEqual(t.storage.saved().sessions[S].queue.map(q => [q.turnId, q.failures]), [['turn-1', 0]])
      assert.equal(t.storage.saved().sessions[S].unread, 0)
      t.tracker.retryCodex(S)
      await t.time.run()
    }
    assert.equal(t.model.calls.length, 5)
    assert.equal(t.storage.saved().sessions[S].lastTurnId, 'turn-1')
  })

  test('three Codex model failures settle the turn with one unread notice', async () => {
    const storage = fakeStorage()
    const first = codexSetup(codexOne(), ['failed'], storage)
    await codexTrack(first)
    await first.tracker.codexNotify(S, 'turn-1')
    await first.tracker.codexStatus(S, true)
    await first.time.run()
    for (let failures = 1; failures < 3; failures++) {
      assert.deepEqual(storage.saved().sessions[S].queue.map(q => q.failures), [failures])
      const restarted = codexSetup(codexOne(), ['failed'], storage)
      await restarted.tracker.start()
      await restarted.time.run()
    }
    assert.equal(storage.saved().sessions[S].lastTurnId, 'turn-1')
    assert.equal(storage.saved().sessions[S].unread, 1)
    assert.deepEqual(storage.saved().sessions[S].queue, [])
  })

  test('an old queued thread keeps its Codex provider and account after /new', async () => {
    const t = codexSetup(codexOne(), ['timeout'])
    const homes: (string | undefined)[] = []
    const original = t.model.model
    const tracker = createTracker({
      storage: t.storage, clock: t.time.clock, read: async () => t.file.bytes,
      codexTurn: async (_id, offset) => t.file.bytes ? readCodexTurn(t.file.bytes, offset) : null,
      model: (prompt, source, home) => { homes.push(home); return original(prompt, source) },
    })
    await tracker.start()
    await tracker.track(T, S, { pane: { key: 'pane-1', codexHome: '/old-account', promptHookSeen: false } })
    await tracker.codexNotify(S, 'turn-1')
    await tracker.codexStatus(S, true)
    await t.time.run()
    assert.equal(t.storage.saved().sessions[S].queue.length, 1)
    await tracker.track(T, 'thread-new', { pane: { key: 'pane-1', codexHome: '/new-account', promptHookSeen: true } })
    tracker.retryCodex(S)
    await t.time.run()
    assert.deepEqual(homes, ['/old-account', '/old-account'])
    assert.equal(t.storage.saved().sessions[S].lastTurnId, 'turn-1')
  })
})
