// Presses with a fake terminal, a fake status, a fake transcript and the real tracker (plan T7).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EMPTY, applyUpdate, parseReply } from './core/ledger'
import type { ModelResult } from './model'
import { CONFIRM_MS, answerText, createPresses, findingText, runText, drawnToken, labelledRows, type PressInput, type TerminalStatus } from './presses'
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

const okModel = (calls: string[]) => async (p: string): Promise<ModelResult> => {
  calls.push(p)
  const update = parseReply('NEW: decide | 2 | Rename the folder to tools? | Yes / No | yes')
  assert.ok(update)
  return { ok: true, update, text: '', ms: 1 }
}

async function setup(opts: { accepted?: boolean; kind?: 'decide' | 'do'; helps?: Help[]; findings?: Finding[] } = {}) {
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
  const update = parseReply(opts.kind === 'do' ? `NEW: do | - | ${TASK} | - | -` : `NEW: decide | 1 | ${ASK} | Yes / No | yes`)
  assert.ok(update)
  const ledger = applyUpdate(EMPTY, update, 0, 1)
  const withHelps = { ...(opts.helps ? { ...ledger, items: ledger.items.map(i => ({ ...i, helps: opts.helps! })) } : ledger), findings: opts.findings ?? [] }
  await tracker.edit(S, s => ({ ...s, offset: file.text.length, lastTurnId: 'p-1', ledger: withHelps }))

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
    const rows = labelledRows(s())
    return [...rows.questions, ...rows.tasks, ...rows.findings.issues, ...rows.findings.opportunities].find(r => r.id === id)?.label ?? null
  }
  const label = () => labelOf(item.id)
  return { time, tracker, presses, status, sent, file, input, label, labelOf, item, s, saved, modelCalls, beforeSend: (f: () => void) => (onRead = f) }
}

describe('presses', () => {
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

  // As in the inbox, a Fix that went out closes its question even when its delivery then fails; a held one sent nothing.
  test('a held or undelivered Fix stays in the open list, and only the undelivered one closed its question; File issue closes nothing', async () => {
    const cases = [
      { status: 'working', accepted: true, action: 'fix', open: ['i1'] },
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
      assert.deepEqual(labelledRows(t.s()).findings.issues.map(r => r.id), [ISSUE.id])
    }
  })

  test('a held Fix reads "Waits for the agent" with Copy; Dismiss closes the finding in state only; Done is refused', async () => {
    const t = await setup({ findings: [ISSUE] })
    t.status.set(T, 'working')
    const out = await t.presses.press(t.input({ id: ISSUE.id, action: 'fix' }))
    assert.deepEqual(out, { ok: true, label: { text: 'Waits for the agent', tone: 'muted', copy: findingText(ISSUE, 'address') } })
    assert.deepEqual(await t.presses.press(t.input({ id: ISSUE.id, action: 'done' })), { ok: false, refused: 'invalid' })
    assert.deepEqual(await t.presses.press(t.input({ id: ISSUE.id, action: 'dismiss' })), { ok: true, label: null })
    assert.deepEqual(t.s().ledger.findings, [])
    assert.deepEqual([t.s().ledger.closedFindings[0].how, t.s().ledger.closedFindings[0].outcome], ['dismissed', 'dismissed'])
    assert.deepEqual(t.sent, [])
    assert.deepEqual(await t.presses.press(t.input({ id: ISSUE.id, action: 'fix' })), { ok: false, refused: 'closed' })
  })
})
