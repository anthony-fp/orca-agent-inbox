// Presses with a fake terminal, a fake status, a fake transcript and the real tracker (plan T7).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EMPTY, applyUpdate, parseReply } from './core/ledger'
import { readFileSync } from 'node:fs'
import { codexPromptAfter } from './core/codex-transcript'
import type { ModelResult } from './model'
import { CONFIRM_MS, UNCONFIRMED_MS, answerText, createPresses, explainText, findingText, runText, drawnToken, labelledRows, type PressInput, type TerminalStatus } from './presses'
import type { Finding, Help } from './core/types'
import { upgradeState } from './state'
import { fakeClock } from './test-clock'
import { createTracker } from './turns'

const S = 'session-1'
const T = 'terminal-1'
const ASK = 'Ship the parser today?'
const TASK = 'Test the build on your Mac'

const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, isSidechain: false, origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } }) + '\n'
const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'
const codexPrompt = (id: string, text: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }) + '\n' +
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'

const okModel = (calls: string[], text = 'NEW: decide | 2 | Rename the folder to tools? | Yes / No | yes') => async (p: string): Promise<ModelResult> => {
  calls.push(p)
  const update = parseReply(text)
  assert.ok(update)
  return { ok: true, update, text: '', ms: 1 }
}

async function setup(opts: { accepted?: boolean; kind?: 'decide' | 'do'; helps?: Help[]; findings?: Finding[]; codex?: boolean; hookSeen?: boolean; modelReply?: string } = {}) {
  const time = fakeClock(1000)
  const saved = new Map<string, unknown>()
  /** Counts of the next saves and transcript reads that reject. */
  const fail = { saves: 0, reads: 0 }
  const storage = {
    get: async (k: string) => saved.get(k) ?? null,
    set: async (k: string, v: unknown) => {
      if (fail.saves > 0 && fail.saves--) throw new Error('value exceeds 262144 bytes')
      saved.set(k, structuredClone(v))
    },
  }
  const file = { text: opts.codex
    ? readFileSync(new URL('./core/fixtures/codex-one.jsonl', import.meta.url), 'utf8')
    : prompt('p-1', 'Prompt 1') + reply('a-1', 'Ship it?') }
  const modelCalls: string[] = []
  let onRead: (() => void) | null = null
  const read = async () => {
    if (fail.reads > 0 && fail.reads--) throw new Error('EIO: read failed')
    onRead?.()
    onRead = null
    return Buffer.from(file.text)
  }
  const tracker = createTracker({ storage, clock: time.clock, read, model: okModel(modelCalls, opts.modelReply) })
  await tracker.track(T, S, opts.codex ? { pane: { key: 'pane-1', codexHome: '/codex', promptHookSeen: opts.hookSeen !== false } } : {})
  const update = parseReply(opts.kind === 'do' ? `NEW: do | - | ${TASK} | - | -` : `NEW: decide | 1 | ${ASK} | Yes / No | yes`)
  assert.ok(update)
  const ledger = applyUpdate(EMPTY, update, 0, 1)
  const withHelps = { ...(opts.helps ? { ...ledger, items: ledger.items.map(i => ({ ...i, helps: opts.helps! })) } : ledger), findings: opts.findings ?? [] }
  await tracker.edit(S, s => ({ ...s, offset: file.text.length, lastTurnId: opts.codex ? 'turn-1' : 'p-1', ledger: withHelps }))

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
  const labelOf = (id: string) => {
    const rows = labelledRows(s(), time.now())
    return [...rows.questions, ...rows.tasks, ...rows.findings.issues, ...rows.findings.opportunities].find(r => r.id === id)?.label ?? null
  }
  const label = () => labelOf(item.id)
  return { time, tracker, presses, status, sent, file, input, label, labelOf, item, s, saved, fail, modelCalls, beforeSend: (f: () => void) => (onRead = f) }
}

describe('presses', () => {
  test('Codex answers stay copyable until a prompt hook has run in that pane', async () => {
    const t = await setup({ codex: true })
    await t.tracker.track('terminal-2', S, { pane: { key: 'pane-2', codexHome: '/codex', promptHookSeen: false } })
    t.status.set('terminal-2', 'done')
    assert.equal(upgradeState(t.saved.get('state')).terminals['terminal-2'].paneKey, 'pane-2')
    const held = await t.presses.press(t.input({ terminalId: 'terminal-2' }))
    assert.deepEqual(held, { ok: true, label: { text: 'Waits for the agent', tone: 'muted', copy: `Re "${ASK}": Yes` } })
    assert.equal(t.s().presses[t.item.id].paneKey, 'pane-2')
    assert.deepEqual(t.sent, [])
    await t.tracker.track('terminal-2', S, { pane: { key: 'pane-2', codexHome: '/codex', promptHookSeen: true } })
    const sent = await t.presses.press(t.input({ terminalId: 'terminal-2' }))
    assert.equal(sent.ok && sent.label?.text, 'Sending…')
    assert.equal(t.sent.length, 1)
  })
  test('a Codex option confirms from the rollout next prompt and keeps its turn id', async () => {
    const t = await setup({ codex: true })
    const out = await t.presses.press(t.input())
    assert.equal(out.ok && out.label?.text, 'Sending…')
    assert.deepEqual(t.sent, [{ terminalId: T, text: `Re "${ASK}": Yes` }])
    t.file.text += codexPrompt('turn-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    assert.deepEqual(t.label(), { text: '✓ Yes', tone: 'success', copy: null })
    assert.equal(t.s().presses[t.item.id].turnId, 'turn-2')
  })

  test('C2: a Codex answer confirmed after its turn drained closes the question; the match gives the turn start', async () => {
    const t = await setup({ codex: true })
    t.status.set(T, 'working')
    await t.presses.press(t.input())
    const start = Buffer.byteLength(t.file.text)
    t.file.text += codexPrompt('turn-2', `Re "${ASK}": Yes`)
    assert.equal(codexPromptAfter(Buffer.from(t.file.text), 0, `Re "${ASK}": Yes`)?.at, start)
    // The turn drains before confirm reads again: the offset moves past it, and the press has no turnId yet.
    await t.tracker.edit(S, s => ({ ...s, offset: Buffer.byteLength(t.file.text), lastTurnId: 'turn-2' }))
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.s().presses[t.item.id]?.turnId, 'turn-2')
    const closed = t.s().ledger.closed.find(c => c.id === t.item.id)
    assert.deepEqual([closed?.how, closed?.outcome], ['answered', 'Yes'])
  })

  test('C3: a reply on a handed-off task reads "Sent, not confirmed" after 10 min and keeps its receipt, also after a restart', async () => {
    const t = await setup({ kind: 'do' })
    const handoff = { worktree: 'test-the-build', operationId: 'op-1', outcome: 'started' as const }
    await t.tracker.edit(S, s => ({ ...s, presses: { [t.item.id]: { state: 'answered', kind: 'handoff', answer: handoff.worktree, text: '', at: 1, handoff } } }))
    t.status.set(T, 'working')
    await t.presses.press(t.input({ action: 'reply', answer: 'Any news?' }))
    await t.time.run(t.time.now() + UNCONFIRMED_MS + 60_000)
    assert.equal(t.label()?.text, 'Sent, not confirmed')
    assert.equal(t.s().presses[t.item.id].state, 'sending')
    assert.deepEqual(t.s().presses[t.item.id].handoff, handoff)
    assert.deepEqual(upgradeState(t.saved.get('state')).sessions[S].presses[t.item.id].handoff, handoff, 'the receipt survives a restart')
  })

  test('C3: a prompt queued behind an 11-minute working turn still confirms, and the question closes after its turn', async () => {
    const t = await setup()
    t.status.set(T, 'working')
    await t.presses.press(t.input())
    await t.time.run(t.time.now() + 11 * 60_000)
    assert.equal(t.label()?.text, 'Sent, not confirmed')
    t.file.text += prompt('p-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, '✓ Yes')
    t.file.text += reply('a-2', 'Shipped.')
    t.status.set(T, 'done')
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.s().ledger.items.some(i => i.id === t.item.id), false)
    assert.equal(t.s().ledger.closed.find(c => c.id === t.item.id)?.how, 'answered')
  })

  for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
    test(`Codex main agent ${state}: sends the option`, async () => {
      const t = await setup({ codex: true })
      t.status.set(T, state)
      const out = await t.presses.press(t.input())
      assert.equal(out.ok && out.label?.text, 'Sending…')
      assert.equal(t.sent.length, 1)
    })
  }

  test('done: sends the option, reads "Sending…", then "✓ <option>" once the prompt shows, as the inbox does', async () => {
    const t = await setup()
    const out = await t.presses.press(t.input())
    assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
    assert.deepEqual(t.sent, [{ terminalId: T, text: `Re "${ASK}": Yes` }])
    t.file.text += prompt('p-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    assert.deepEqual(t.label(), { text: '✓ Yes', tone: 'success', copy: null })
    assert.equal(t.s().presses[t.item.id].turnId, 'p-2')
  })

  for (const state of ['working', 'blocked', 'waiting'] as const) {
    test(`${state}: sends the answer immediately`, async () => {
      const t = await setup()
      t.status.set(T, state)
      const out = await t.presses.press(t.input())
      assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
      assert.deepEqual(t.sent, [{ terminalId: T, text: `Re "${ASK}": Yes` }])
      await t.time.run(t.time.now() + CONFIRM_MS * 2)
      assert.equal(t.label()?.text, 'Sending…', 'the confirmation timer waits while the agent works')
    })
  }

  test('the press save rejects, then one confirm read rejects; the prompt still confirms the answer', async () => {
    const t = await setup()
    t.fail.saves = 1
    t.beforeSend(() => (t.fail.reads = 1))
    const out = await t.presses.press(t.input())
    assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
    assert.deepEqual(t.sent, [{ terminalId: T, text: `Re "${ASK}": Yes` }])
    t.file.text += prompt('p-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 3000)
    assert.equal(t.fail.reads, 0, 'a confirm read rejected')
    assert.deepEqual(t.label(), { text: '✓ Yes', tone: 'success', copy: null })
  })

  test('a status change to working between the press and the send still sends the answer', async () => {
    const t = await setup()
    t.beforeSend(() => t.status.set(T, 'working'))
    const out = await t.presses.press(t.input())
    assert.equal(out.ok && out.label?.text, 'Sending…')
    assert.equal(t.sent.length, 1)
  })

  test('a new session in the terminal between the press and the send holds the answer', async () => {
    const t = await setup()
    t.beforeSend(() => void t.tracker.track(T, 'session-2'))
    const out = await t.presses.press(t.input())
    assert.equal(out.ok && out.label?.text, 'Waits for the agent')
    assert.deepEqual(t.sent, [])
  })

  test('a turn that ends between the draw and the press still sends the answer', async () => {
    const t = await setup()
    const drawn = drawnToken(t.s())
    await t.tracker.edit(S, s => ({ ...s, lastTurnId: 'p-9' }))
    const out = await t.presses.press(t.input({ drawn }))
    assert.equal(out.ok && out.label?.text, 'Sending…')
    assert.equal(t.sent.length, 1)
  })

  test('a queued answer confirms when its prompt appears after a long working turn', async () => {
    const t = await setup()
    t.status.set(T, 'working')
    await t.presses.press(t.input())
    await t.time.run(t.time.now() + CONFIRM_MS * 2)
    assert.equal(t.label()?.text, 'Sending…')
    t.file.text += prompt('p-2', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, '✓ Yes')
  })

  test('a working press is not undelivered before done, even if another prompt appears', async () => {
    const t = await setup()
    t.status.set(T, 'working')
    await t.presses.press(t.input())
    t.file.text += prompt('p-2', 'Something else')
    await t.time.run(t.time.now() + CONFIRM_MS * 2)
    assert.equal(t.label()?.text, 'Sending…')
    t.status.set(T, 'done')
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, 'Not delivered')
  })

  test('a queued answer confirms after an unrelated prompt while working', async () => {
    const t = await setup()
    t.status.set(T, 'working')
    await t.presses.press(t.input())
    t.file.text += prompt('p-2', 'Something else')
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, 'Sending…')
    t.file.text += prompt('p-3', `Re "${ASK}": Yes`)
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, '✓ Yes')
    assert.equal(t.s().presses[t.item.id].turnId, 'p-3')
  })

  test('a working press starts its delivery deadline after done', async () => {
    const t = await setup()
    t.status.set(T, 'working')
    await t.presses.press(t.input())
    await t.time.run(t.time.now() + CONFIRM_MS * 2)
    t.status.set(T, 'done')
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.label()?.text, 'Sending…')
    await t.time.run(t.time.now() + CONFIRM_MS)
    assert.equal(t.label()?.text, 'Not delivered')
  })

  test('a saved held label leaves the normal press buttons available', async () => {
    const t = await setup()
    await t.tracker.edit(S, s => ({ ...s, presses: { ...s.presses, [t.item.id]: {
      state: 'held', kind: 'answer', answer: 'Yes', text: `Re "${ASK}": Yes`, at: 1,
    } } }))
    assert.equal(t.label(), null)
    assert.equal(upgradeState(t.saved.get('state')).sessions[S].presses[t.item.id].state, 'held')
    assert.equal((await t.presses.press(t.input())).ok, true)
    assert.equal(t.sent.length, 1)
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
    assert.equal(answerText({ kind: 'question', ask: 'Pick\none?' } as never, 'a\nb'), 'Re "Pick one?": a b')
    assert.equal(
      answerText({ kind: 'task', ask: 'Run\nit' } as never, 'ran\nit'),
      'Re the task you left for me, "Run it": ran it',
    )
  })

  test("a run step sends the inbox's run message on one line, reads \"✓ Handed off: <step>\", and leaves the row open", async () => {
    const run: Help = { kind: 'run', command: 'psql -f checks/friday.sql', name: 'Friday check query' }
    const t = await setup({ kind: 'do', helps: [run] })
    const sent = `For "${TASK}", run this: \`\`\` psql -f checks/friday.sql \`\`\``
    assert.equal(runText(t.item, run.command), sent)
    await t.presses.press(t.input({ action: 'step', answer: undefined, step: { index: 0, label: 'Run Friday check query' } }))
    assert.deepEqual(t.sent, [{ terminalId: T, text: sent }])
    t.file.text += prompt('p-2', sent)
    await t.time.run(t.time.now() + 2000)
    assert.deepEqual(t.label(), { text: '✓ Handed off: Run Friday check query', tone: 'success', copy: null })
    t.file.text += reply('a-2', 'Ran it.')
    void t.tracker.done(T)
    await t.time.run()
    assert.deepEqual(t.s().ledger.closed, [])
  })

  test('a step press whose step changed since the draw is refused and sends nothing', async () => {
    const run: Help = { kind: 'run', command: 'make check', name: null }
    const t = await setup({ kind: 'do', helps: [run] })
    for (const step of [{ index: 0, label: 'Run something else' }, { index: 3, label: 'Run make check' }])
      assert.deepEqual(await t.presses.press(t.input({ action: 'step', step })), { ok: false, refused: 'invalid' })
    assert.deepEqual(t.sent, [])
  })

  test("a task's reply sends the inbox's task message, reads \"✓ Replied\", and leaves the task open", async () => {
    const t = await setup({ kind: 'do' })
    const sent = `Re the task you left for me, "${TASK}": Ran it, all green`
    await t.presses.press(t.input({ action: 'reply', answer: 'Ran it, all green' }))
    assert.deepEqual(t.sent, [{ terminalId: T, text: sent }])
    t.file.text += prompt('p-2', sent)
    await t.time.run(t.time.now() + 2000)
    assert.deepEqual(t.label(), { text: '✓ Replied', tone: 'success', copy: null })
    t.file.text += reply('a-2', 'Good.')
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.modelCalls.length, 1)
    assert.deepEqual(t.s().ledger.closed, [], 'the reply closes nothing: the model decides')
    assert.ok(t.s().ledger.items.some(i => i.id === t.item.id))
  })

  test('a typed reply on a question leaves it open until the inbox model runs, and the model decides', async () => {
    const t = await setup()
    const sent = `Re "${ASK}": Only after the tests pass`
    await t.presses.press(t.input({ action: 'reply', answer: 'Only after the tests pass' }))
    assert.deepEqual(t.sent, [{ terminalId: T, text: sent }])
    t.file.text += prompt('p-2', sent)
    await t.time.run(t.time.now() + 2000)
    assert.deepEqual(t.label(), { text: '✓ Replied', tone: 'success', copy: null })
    assert.ok(t.s().ledger.items.some(i => i.id === t.item.id), 'the reply closes nothing at once')
    t.file.text += reply('a-2', 'I will wait for the tests.')
    void t.tracker.done(T)
    await t.time.run()
    assert.equal(t.modelCalls.length, 1)
    const block = (name: string) => t.modelCalls[0].split(`<${name}>`)[1].split(`</${name}>`)[0]
    assert.ok(block('open').includes(ASK), 'the model reads the question as still open')
    assert.ok(t.s().ledger.items.some(i => i.id === t.item.id))
  })

  test('an option that is not one of the question\'s options is refused', async () => {
    const t = await setup()
    assert.deepEqual(await t.presses.press(t.input({ answer: 'Maybe' })), { ok: false, refused: 'invalid' })
    assert.deepEqual(t.sent, [])
  })

  const ISSUE: Finding = { id: 'i7', kind: 'issue', title: 'The retry loop never backs off', detail: 'Each retry fires at once.', path: 'src/fetch.ts', at: 0 }
  const IDEA: Finding = { id: 'i8', kind: 'opportunity', title: 'Cache the config', detail: 'It is parsed on each call.', path: null, at: 0 }

  test("a finding's Fix, File issue and Reply send the inbox's finding messages on one line, each with its label", async () => {
    const cases = [
      { action: 'fix', finding: ISSUE, text: findingText(ISSUE, 'address'), done: '✓ Handed off' },
      { action: 'fix', finding: IDEA, text: findingText(IDEA, 'address'), done: '✓ Handed off' },
      { action: 'issue', finding: ISSUE, text: findingText(ISSUE, 'issue'), done: '✓ Asked to file' },
      { action: 'reply', finding: ISSUE, text: findingText(ISSUE, 'typed', 'Use a jitter'), done: '✓ Replied' },
    ] as const
    for (const c of cases) {
      const t = await setup({ findings: [c.finding] })
      const out = await t.presses.press(t.input({ id: c.finding.id, action: c.action, answer: c.action === 'reply' ? 'Use a jitter' : undefined }))
      assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
      assert.deepEqual(t.sent, [{ terminalId: T, text: c.text }])
      t.file.text += prompt('p-2', c.text)
      await t.time.run(t.time.now() + 2000)
      // A delivered Fix shows in the closed list instead (see the next test).
      if (c.action !== 'fix') assert.deepEqual(t.labelOf(c.finding.id), { text: c.done, tone: 'success', copy: null })
      t.file.text += reply('a-2', 'On it.')
      void t.tracker.done(T)
      await t.time.run()
      assert.ok(t.s().ledger.findings.some(f => f.id === c.finding.id), 'the finding stays open: the agent closes it')
      if (c.action !== 'fix') assert.deepEqual(t.labelOf(c.finding.id)?.text, c.done, 'the label outlives the turn while the finding is open')
      else assert.equal(t.s().presses[c.finding.id]?.state, 'answered', 'the label outlives the turn while the finding is open')
    }
    assert.equal(
      findingText(ISSUE, 'address'),
      'Please address this finding you recorded: Issue: The retry loop never backs off Each retry fires at once. File: src/fetch.ts',
    )
    assert.equal(
      findingText(IDEA, 'typed', 'Do it\nnow'),
      'About this finding you recorded: Opportunity: Cache the config It is parsed on each call. Do it now',
    )
  })

  test('Explain on a question, a task and a finding sends the explain text, reads "Explaining…", then "✓ Explained", and marks the row explained', async () => {
    const cases = [
      { kind: 'decide', finding: undefined, text: `Remind me what this question you asked me is about: why it came up, what each choice would mean, and which you would pick. Don't act on it yet. "${ASK}" Options: Yes / No` },
      { kind: 'do', finding: undefined, text: `Remind me what this task you left for me is about: why it came up, and what each choice would mean. Don't act on it yet. "${TASK}"` },
      { kind: 'decide', finding: ISSUE, text: findingText(ISSUE, 'explain') },
    ] as const
    for (const c of cases) {
      const t = await setup({ kind: c.kind, findings: c.finding ? [c.finding] : [] })
      const id = c.finding?.id ?? t.item.id
      if (!c.finding) assert.equal(explainText(t.item), c.text)
      const out = await t.presses.press(t.input({ id, action: 'explain', answer: undefined }))
      assert.deepEqual(out, { ok: true, label: { text: 'Explaining…', tone: 'muted', copy: null } })
      assert.deepEqual(t.sent, [{ terminalId: T, text: c.text }])
      t.file.text += prompt('p-2', c.text)
      await t.time.run(t.time.now() + 2000)
      assert.deepEqual(t.labelOf(id), { text: '✓ Explained', tone: 'success', copy: null })
      const rows = labelledRows(t.s())
      const row = [...rows.questions, ...rows.tasks, ...rows.findings.issues].find(r => r.id === id)
      assert.equal(row?.explained, true, 'the Explain button reads "Explain again"')
    }
    assert.equal(
      findingText(ISSUE, 'explain'),
      "Remind me what this finding you recorded is about: why it matters, what fixing it would involve, and whether you would fix it now. Don't act on it yet. Issue: The retry loop never backs off Each retry fires at once. File: src/fetch.ts",
    )
  })

  test('the turn an Explain press starts keeps its row open when the model closes it; a reply turn lets it close', async () => {
    for (const action of ['explain', 'reply'] as const) {
      const t = await setup({ modelReply: 'CLOSED: i1 | yes' })
      assert.equal(t.item.id, 'i1')
      await t.presses.press(t.input({ action, answer: action === 'reply' ? 'Why?' : undefined }))
      t.file.text += prompt('p-2', t.sent[0].text)
      await t.time.run(t.time.now() + 2000)
      t.file.text += reply('a-2', 'It came up because the folder name clashes.')
      void t.tracker.done(T)
      await t.time.run()
      assert.equal(t.modelCalls.length, 1)
      assert.equal(t.s().ledger.items.some(i => i.id === 'i1'), action === 'explain', `${action}: row open after the turn`)
    }
  })

  test('a Fix closes the question that asks about its finding as it sends, and moves the finding to the closed list once delivered', async () => {
    const t = await setup({ findings: [{ ...ISSUE, askedAs: 'i1' }] })
    assert.equal(t.item.id, 'i1')
    const at = t.time.now()
    await t.presses.press(t.input({ id: ISSUE.id, action: 'fix' }))
    assert.deepEqual(t.s().ledger.items, [])
    assert.deepEqual(t.s().ledger.closed.map(c => [c.id, c.how, c.outcome]), [['i1', 'update', `fix sent for ${ISSUE.id}`]])
    assert.deepEqual(t.labelOf(ISSUE.id), { text: 'Sending…', tone: 'muted', copy: null }, 'the row stays in place while it sends')
    t.file.text += prompt('p-2', findingText(ISSUE, 'address'))
    await t.time.run(t.time.now() + 2000)
    const rows = labelledRows(t.s(), at)
    assert.deepEqual(rows.findings.issues, [])
    // As in the inbox (commit 2d4bd27), the sent Fix reads its button's label, though a question asked about it.
    assert.deepEqual(rows.findings.closed.issues, { shown: [{ id: ISSUE.id, mark: '✓', text: ISSUE.title, outcome: 'Fix', age: 'now' }], total: 1 })
    assert.ok(t.s().ledger.findings.some(f => f.id === ISSUE.id), 'the ledger keeps it open for the agent and the inbox model')
  })

  // A Fix that went out closes its question even when delivery then fails.
  test('sent and undelivered Fixes close their question; File issue closes nothing', async () => {
    const cases = [
      { status: 'working', accepted: true, action: 'fix', open: [] },
      { status: 'done', accepted: false, action: 'fix', open: [] },
      { status: 'done', accepted: true, action: 'issue', open: ['i1'] },
    ] as const
    for (const c of cases) {
      const t = await setup({ findings: [{ ...ISSUE, askedAs: 'i1' }], accepted: c.accepted })
      t.status.set(T, c.status)
      await t.presses.press(t.input({ id: ISSUE.id, action: c.action }))
      t.file.text += prompt('p-2', findingText(ISSUE, c.action === 'fix' ? 'address' : 'issue'))
      await t.time.run(t.time.now() + 2000)
      assert.deepEqual(t.s().ledger.items.map(i => i.id), c.open)
      assert.deepEqual(labelledRows(t.s()).findings.issues.map(r => r.id), c.action === 'fix' && c.accepted ? [] : [ISSUE.id])
    }
  })

  test('a working Fix sends immediately; Dismiss closes the finding in state only; Done is refused', async () => {
    const t = await setup({ findings: [ISSUE] })
    t.status.set(T, 'working')
    const out = await t.presses.press(t.input({ id: ISSUE.id, action: 'fix' }))
    assert.deepEqual(out, { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } })
    assert.deepEqual(await t.presses.press(t.input({ id: ISSUE.id, action: 'done' })), { ok: false, refused: 'invalid' })
    assert.deepEqual(await t.presses.press(t.input({ id: ISSUE.id, action: 'dismiss' })), { ok: true, label: null })
    assert.deepEqual(t.s().ledger.findings, [])
    assert.deepEqual([t.s().ledger.closedFindings[0].how, t.s().ledger.closedFindings[0].outcome], ['dismissed', 'dismissed'])
    assert.equal(t.sent.length, 1)
    assert.deepEqual(await t.presses.press(t.input({ id: ISSUE.id, action: 'fix' })), { ok: false, refused: 'closed' })
  })
})

test('press text drops control characters an agent could put in a row', async () => {
  const { oneLine } = await import('./presses')
  assert.equal(oneLine('Use \u001b[2Jport\u0003 4000\tnow\nplease\u007f'), 'Use [2Jport 4000 now please')
})

// The confirm/drain race (docs/confirm-race-plan.md): a model that waits on a gate, and confirm() reads that can be blind.
const RACE_ASK = 'Drop bell for now?'
const YES = 'Drop bell for now (recommended)'

async function raceSetup() {
  const time = fakeClock(1000)
  const saved = new Map<string, unknown>()
  const storage = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: unknown) => void saved.set(k, structuredClone(v)) }
  const file = { text: prompt('p-1', 'Prompt 1') + reply('a-1', 'Ship it?') }
  // The model: each call waits until the test lets it go.
  const gate = { open: true, waiting: [] as (() => void)[] }
  const model = async (): Promise<ModelResult> => {
    if (!gate.open) await new Promise<void>(r => gate.waiting.push(r))
    return { ok: true, update: parseReply('NEW: decide | 2 | Rename the folder to tools? | Yes / No | yes')!, text: '', ms: 1 }
  }
  const tracker = createTracker({ storage, clock: time.clock, read: async () => Buffer.from(file.text), model })
  await tracker.track(T, S, {})
  const ledger = applyUpdate(EMPTY, parseReply(`NEW: decide | 1 | ${RACE_ASK} | ${YES} / Keep bell | -`)!, 0, 1)
  await tracker.edit(S, s => ({ ...s, offset: file.text.length, lastTurnId: 'p-1', ledger }))
  const status = new Map<string, TerminalStatus>([[T, 'working']])
  // confirm()'s reads: `blind` makes them see no transcript, as a slow or failed read does.
  const watch = { blind: false, reads: 0 }
  const presses = createPresses({
    state: () => tracker.state(), edit: (id, c) => tracker.edit(id, c), status: id => status.get(id),
    send: async () => true,
    read: async () => (watch.reads++, watch.blind ? null : Buffer.from(file.text)),
    clock: time.clock,
  })
  const s = () => tracker.state().sessions[S]
  const item = s().ledger.items[0]
  const press = () => presses.press({ terminalId: T, sessionId: S, drawn: drawnToken(s()), id: item.id, action: 'answer', answer: YES })
  const isOpen = () => s().ledger.items.some(i => i.id === item.id)
  const label = () => labelledRows(s(), time.now()).questions.find(r => r.id === item.id)?.label?.text ?? null
  const closed = () => {
    const c = s().ledger.closed.find(x => x.id === item.id)
    return c ? { how: c.how, outcome: c.outcome } : null
  }
  return { time, file, gate, watch, status, tracker, press, isOpen, label, closed, s, item }
}

describe('confirm race', () => {
  test('C1: confirm matches while drain awaits the model; the commit closes the question as answered', async () => {
    const t = await raceSetup()
    await t.press()
    t.watch.blind = true // confirm misses the prompt from here
    t.gate.open = false
    t.file.text += prompt('p-2', `Re "${RACE_ASK}": ${YES}`) + reply('a-2', 'Dropped.')
    void t.tracker.done(T)
    await t.time.run(t.time.now() + 5000) // quiet 2 s, queued, drain now waits on the model
    assert.equal(t.gate.waiting.length, 1, 'drain waits on the model')
    t.watch.blind = false
    await t.time.run(t.time.now() + 2000) // confirm matches during the await
    assert.equal(t.s().presses[t.item.id]?.turnId, 'p-2', 'confirm set turnId during the await')
    t.gate.open = true
    t.gate.waiting.splice(0).forEach(w => w())
    await t.time.run(t.time.now() + 5000)
    assert.equal(t.isOpen(), false, `question still open; label=${t.label()}`)
    assert.deepEqual(t.closed(), { how: 'answered', outcome: YES })
  })

  test('C2: confirm matches after the turn drained; confirm closes the question as answered', async () => {
    const t = await raceSetup()
    await t.press()
    t.watch.blind = true
    t.file.text += prompt('p-2', `Re "${RACE_ASK}": ${YES}`) + reply('a-2', 'Dropped.')
    void t.tracker.done(T)
    await t.time.run(t.time.now() + 5000)
    assert.equal(t.s().lastTurnId, 'p-2', 'the turn drained')
    assert.equal(t.isOpen(), true, 'drain did not close it: no turnId yet')
    t.watch.blind = false
    await t.time.run(t.time.now() + 2000)
    assert.equal(t.s().presses[t.item.id]?.turnId, 'p-2', 'confirm set turnId after the drain')
    assert.equal(t.isOpen(), false, `question still open; label=${t.label()}`)
    assert.deepEqual(t.closed(), { how: 'answered', outcome: YES })
  })

  test('C3: the status never reaches done; after 10 min the label reads "Sent, not confirmed", stays sending, and confirm stops at 24 h', async () => {
    const t = await raceSetup()
    await t.press()
    await t.time.run(t.time.now() + 11 * 60_000)
    assert.equal(t.label(), 'Sent, not confirmed', `label after 11 min: ${t.label()}`)
    assert.equal(t.s().presses[t.item.id].state, 'sending', 'no new stored state')
    await t.time.run(t.time.now() + 25 * 3600_000)
    const reads = t.watch.reads
    await t.time.run(t.time.now() + 3600_000)
    assert.equal(t.watch.reads, reads, `confirm still polls after 25 h (${t.watch.reads - reads} reads in the next hour)`)
  })
})
