// Presses with a fake terminal, a fake status, a fake transcript and the real tracker (plan T7).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EMPTY, applyUpdate, parseReply } from './core/ledger'
import type { ModelResult } from './model'
import { CONFIRM_MS, answerText, createPresses, drawnToken, labelledRows, type PressInput, type TerminalStatus } from './presses'
import { upgradeState } from './state'
import { fakeClock } from './test-clock'
import { createTracker } from './turns'

const S = 'session-1'
const T = 'terminal-1'
const ASK = 'Ship the parser today?'

const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, isSidechain: false, origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'

const okModel = (calls: string[]) => async (p: string): Promise<ModelResult> => {
  calls.push(p)
  const update = parseReply('NEW: decide | 2 | Rename the folder to tools? | Yes / No | yes')
  assert.ok(update)
  return { ok: true, update, text: '', ms: 1 }
}

async function setup(opts: { accepted?: boolean } = {}) {
  const time = fakeClock(1000)
  const saved = new Map<string, unknown>()
  const storage = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: unknown) => void saved.set(k, structuredClone(v)) }
  const file = { text: prompt('p-1', 'Prompt 1') + reply('a-1', 'Ship it?') }
  const modelCalls: string[] = []
  let onRead: (() => void) | null = null
  const read = async () => {
    onRead?.()
    onRead = null
    return Buffer.from(file.text)
  }
  const tracker = createTracker({ storage, clock: time.clock, read, model: okModel(modelCalls) })
  await tracker.track(T, S)
  const update = parseReply(`NEW: decide | 1 | ${ASK} | Yes / No | yes`)
  assert.ok(update)
  await tracker.edit(S, s => ({ ...s, offset: file.text.length, lastTurnId: 'p-1', ledger: applyUpdate(EMPTY, update, 0, 1) }))

  const status = new Map<string, TerminalStatus>([[T, 'done']])
  const sent: { terminalId: string; text: string }[] = []
  const presses = createPresses({
    state: () => tracker.state(),
    edit: (id, change) => tracker.edit(id, change),
    status: id => status.get(id),
    send: async (terminalId, text) => {
      sent.push({ terminalId, text })
      return opts.accepted ?? true
    },
    read,
    clock: time.clock,
  })
  const s = () => tracker.state().sessions[S]
  const item = s().ledger.items[0]
  const input = (over: Partial<PressInput> = {}): PressInput => ({ terminalId: T, sessionId: S, drawn: drawnToken(s()), id: item.id, action: 'answer', answer: 'Yes', ...over })
  const label = () => labelledRows(s()).questions.find(r => r.id === item.id)?.label ?? null
  return { time, tracker, presses, status, sent, file, input, label, item, s, saved, modelCalls, beforeSend: (f: () => void) => (onRead = f) }
}

describe('presses', () => {
  test('done: sends the answer, reads "Sending…", then "✓ Answered" once the prompt shows', async () => {
    const t = await setup()
    const out = await t.presses.press(t.input())
    assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
    assert.deepEqual(t.sent, [{ terminalId: T, text: `Re "${ASK}": Yes` }])
    t.file.text += prompt('p-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    assert.deepEqual(t.label(), { text: '✓ Answered', tone: 'success', copy: null })
    assert.equal(t.s().presses[t.item.id].turnId, 'p-2')
  })

  for (const state of ['working', 'blocked', 'waiting'] as const) {
    test(`${state}: holds the answer, reads "Waits for the agent" with Copy, sends nothing`, async () => {
      const t = await setup()
      t.status.set(T, state)
      const out = await t.presses.press(t.input())
      assert.deepEqual(out, { ok: true, label: { text: 'Waits for the agent', tone: 'muted', copy: `Re "${ASK}": Yes` } })
      assert.deepEqual(t.sent, [])
      await t.time.run(t.time.now() + CONFIRM_MS * 2)
      assert.deepEqual(t.sent, [], 'a held answer is never sent by itself')
      assert.equal(t.label()?.text, 'Waits for the agent')
    })
  }

  test('a status change to working between the press and the send holds the answer', async () => {
    const t = await setup()
    t.beforeSend(() => t.status.set(T, 'working'))
    const out = await t.presses.press(t.input())
    assert.equal(out.ok && out.label?.text, 'Waits for the agent')
    assert.deepEqual(t.sent, [])
  })

  test('a new session in the terminal between the press and the send holds the answer', async () => {
    const t = await setup()
    t.beforeSend(() => void t.tracker.track(T, 'session-2'))
    const out = await t.presses.press(t.input())
    assert.equal(out.ok && out.label?.text, 'Waits for the agent')
    assert.deepEqual(t.sent, [])
  })

  test('a turn that ends between the draw and the press holds the answer', async () => {
    const t = await setup()
    const drawn = drawnToken(t.s())
    await t.tracker.edit(S, s => ({ ...s, lastTurnId: 'p-9' }))
    const out = await t.presses.press(t.input({ drawn }))
    assert.equal(out.ok && out.label?.text, 'Waits for the agent')
    assert.deepEqual(t.sent, [])
  })

  test('no new prompt within 10 s reads "Not delivered" in red with Copy, and is never sent again', async () => {
    const t = await setup()
    await t.presses.press(t.input())
    await t.time.run(t.time.now() + CONFIRM_MS + 1000)
    assert.deepEqual(t.label(), { text: 'Not delivered', tone: 'danger', copy: `Re "${ASK}": Yes` })
    await t.time.run(t.time.now() + CONFIRM_MS * 3)
    assert.equal(t.sent.length, 1)
  })

  test('another prompt first reads "Not delivered"', async () => {
    const t = await setup()
    await t.presses.press(t.input())
    t.file.text += prompt('p-2', 'Something else')
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, 'Not delivered')
  })

  test('a send Orca does not accept reads "Not delivered"', async () => {
    const t = await setup({ accepted: false })
    const out = await t.presses.press(t.input())
    assert.equal(out.ok && out.label?.text, 'Not delivered')
  })

  test('a press for a row that closed since it was drawn is refused', async () => {
    const t = await setup()
    await t.presses.press(t.input({ action: 'dismiss' }))
    assert.deepEqual(await t.presses.press(t.input()), { ok: false, refused: 'closed' })
    assert.deepEqual(t.sent, [])
  })

  test('done and dismiss close the row in state only', async () => {
    for (const [action, how] of [['done', 'done'], ['dismiss', 'dismissed']] as const) {
      const t = await setup()
      assert.deepEqual(await t.presses.press(t.input({ action })), { ok: true, label: null })
      assert.deepEqual(t.s().ledger.items, [])
      assert.equal(t.s().ledger.closed[0].how, how)
      assert.deepEqual(t.sent, [])
    }
  })

  test('the turn that answers a press closes the row as answered before the model reads it', async () => {
    const t = await setup()
    await t.presses.press(t.input())
    t.file.text += prompt('p-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    t.file.text += reply('a-2', 'Shipped.')
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.modelCalls.length, 1)
    const block = (name: string) => t.modelCalls[0].split(`<${name}>`)[1].split(`</${name}>`)[0]
    assert.ok(!block('open').includes(ASK) && block('decided').includes(ASK), 'the model reads the row as decided')
    const closed = t.s().ledger.closed.find(c => c.id === t.item.id)
    assert.deepEqual([closed?.how, closed?.outcome], ['answered', 'Yes'])
    assert.deepEqual(t.s().presses, {}, 'the label goes with its row')
  })

  test('labels outlive a restart; one whose send was out reads "Not delivered"', async () => {
    const t = await setup()
    await t.presses.press(t.input())
    const after = upgradeState(t.saved.get('state'))
    assert.equal(after.sessions[S].presses[t.item.id].state, 'undelivered')
  })

  test('an answer goes on one line', () => {
    assert.equal(answerText({ ask: 'Pick\none?' } as never, 'a\nb'), 'Re "Pick one?": a b')
  })
})
