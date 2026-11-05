// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { EMPTY_VIEW, ONE_AGENT, THREE_AGENTS, section } from './panel-views'
import type { InboxView } from './protocol'
import type { PressInput, PressOutcome } from './presses'

const texts = (view: Awaited<ReturnType<typeof mount>>, type: string) =>
  view.findAll({ type }).map(e => e.text)

async function open(view: InboxView, press?: (input: PressInput) => PressOutcome | Promise<PressOutcome>) {
  const host = mockHost({ requests: { 'inbox.view': () => view, ...(press ? { 'inbox.press': press } : {}) } })
  return mount(panel, { host })
}

async function clean(view: Awaited<ReturnType<typeof mount>>) {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
}

test('zero agents: says no agents are in this workspace', async () => {
  const view = await open(EMPTY_VIEW)
  assert.ok(view.find({ type: 'EmptyState', label: 'No agents in this workspace' }))
  assert.equal(view.find({ text: /not tracked/ }), null)
  await clean(view)
})

test('agents with nothing open: says nothing waits on you', async () => {
  const view = await open({ sections: [section(1), section(2)], untracked: 0, unread: 0 })
  assert.ok(view.find({ type: 'EmptyState', label: 'Nothing waits on you' }))
  await clean(view)
})

test('one agent: its title, then Questions and Tasks with their counts and buttons in the Now order', async () => {
  const view = await open(ONE_AGENT)
  assert.deepEqual(texts(view, 'Heading'), ['Agent 1'])
  assert.ok(view.find({ text: 'Questions · 1' }))
  assert.ok(view.find({ text: 'Tasks · 1' }))
  assert.ok(view.find({ text: 'Rename the folder to tools?' }))
  assert.ok(view.find({ type: 'Input', label: 'Your answer' }))
  // Question: options, Reply, Dismiss. Task: Done, Dismiss.
  assert.deepEqual(texts(view, 'Button'), ['Yes', 'No', 'Reply', 'Dismiss', 'Done', 'Dismiss'])
  await clean(view)
})

test('three agents: one section each, newest first, with the labels the worker gave', async () => {
  const view = await open(THREE_AGENTS)
  assert.deepEqual(texts(view, 'Heading'), ['Agent 1', 'Agent 2', 'Agent 3'])
  assert.ok(view.find({ text: 'Questions · 2' }))
  assert.ok(view.find({ text: 'Tasks · 2' }))
  assert.ok(view.find({ text: 'Waits for the agent' }))
  assert.ok(view.find({ text: 'Not delivered' }))
  assert.ok(view.find({ text: '✓ Answered' }))
  // Copy shows only on the labels that carry text to copy.
  assert.equal(view.findAll({ type: 'Button', text: 'Copy' }).length, 2)
  await clean(view)
})

test('Copy shows the answer text to select', async () => {
  const view = await open(THREE_AGENTS)
  await view.press({ type: 'Button', text: 'Copy' })
  const code = view.find({ type: 'CodeView' })
  assert.equal(code?.props.code, 'Re "Which port should the dev server use?": 4000')
  await view.press({ type: 'Button', text: 'Hide' })
  assert.equal(view.find({ type: 'CodeView' }), null)
  await clean(view)
})

test('footer: counts agents not tracked and turns not read', async () => {
  const view = await open({ ...ONE_AGENT, untracked: 1, unread: 2 })
  assert.ok(view.find({ text: '1 agent not tracked' }))
  assert.ok(view.find({ text: "Started outside Orca's launch, or restored after a restart." }))
  assert.ok(view.find({ text: '2 turns not read' }))
  await view.unmount()
  const three = await open(THREE_AGENTS)
  assert.ok(three.find({ text: '2 agents not tracked' }))
  assert.ok(three.find({ text: '1 turn not read' }))
  await clean(three)
})

test('an option press shows Sending… at once, sends the drawn row, then shows the worker label', async () => {
  let release: (out: PressOutcome) => void = () => {}
  const inputs: PressInput[] = []
  const view = await open(ONE_AGENT, input => {
    inputs.push(input)
    return new Promise(done => (release = done))
  })
  const pressing = view.press({ type: 'Button', text: 'Yes' })
  for (let i = 0; i < 5 && !view.find({ text: 'Sending…' }); i++) await new Promise(r => setTimeout(r, 0))
  assert.ok(view.find({ text: 'Sending…' }), 'the label shows before the worker answers')
  assert.equal(view.find({ type: 'Button', text: 'Yes' })?.disabled, true)
  release({ ok: true, label: { text: 'Waits for the agent', tone: 'muted', copy: 'Re "Rename the folder to tools?": Yes' } })
  await pressing
  assert.deepEqual(inputs, [
    { terminalId: 'terminal-1', sessionId: 'session-1', drawn: 'drawn-1', id: 'q1', action: 'answer', answer: 'Yes' },
  ])
  assert.ok(view.find({ text: 'Waits for the agent' }))
  assert.ok(view.find({ type: 'Button', text: 'Copy' }))
  await clean(view)
})

test('a typed reply sends the words, and Done sends done', async () => {
  const inputs: PressInput[] = []
  const view = await open(ONE_AGENT, input => {
    inputs.push(input)
    return { ok: true, label: input.action === 'answer' ? { text: 'Sending…', tone: 'muted', copy: null } : null }
  })
  await view.type({ type: 'Input', label: 'Your answer' }, 'Call it utils')
  await view.press({ type: 'Button', text: 'Reply' })
  await view.press({ type: 'Button', text: 'Done' })
  assert.deepEqual(
    inputs.map(i => [i.id, i.action, i.answer]),
    [
      ['q1', 'answer', 'Call it utils'],
      ['t1', 'done', undefined],
    ],
  )
  assert.equal(view.valueOf({ type: 'Input', label: 'Your answer' }), '')
  await clean(view)
})

test('a refused press shows why on its row', async () => {
  const view = await open(ONE_AGENT, input =>
    input.action === 'dismiss' ? { ok: false, refused: 'closed' } : { ok: false, refused: 'invalid' },
  )
  await view.press({ type: 'Button', text: 'No' })
  assert.ok(view.find({ text: 'Not sent' }))
  const dismiss = view.findAll({ type: 'Button', text: 'Dismiss' })[1]
  assert.ok(dismiss)
  await view.press(dismiss)
  assert.ok(view.find({ text: 'Closed already' }))
  await clean(view)
})

test('inbox.changed asks for the view again', async () => {
  let current: InboxView = EMPTY_VIEW
  const host = mockHost({ requests: { 'inbox.view': () => current } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState', label: 'No agents in this workspace' }))
  current = ONE_AGENT
  await view.post('inbox.changed', {})
  assert.ok(view.find({ text: 'Rename the folder to tools?' }))
  await clean(view)
})
