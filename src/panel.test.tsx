// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { EMPTY_VIEW, MANY_OPTIONS, ONE_AGENT, STEPS, THREE_AGENTS, section } from './panel-views'
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
  // A question's number goes before its text, and each row's age on its right, as the inbox draws them.
  assert.ok(view.find({ text: '1) Rename the folder to tools?' }))
  assert.ok(view.find({ text: '2h' }))
  assert.ok(view.find({ text: 'Run the migration on staging' }))
  assert.ok(view.find({ text: '5m' }))
  // The inbox's rowActions (hooks/view.ts): question options, Reply, Dismiss; task Done, Reply. No field until Reply.
  assert.deepEqual(texts(view, 'Button'), ['Yes', 'No', 'Reply', 'Dismiss', 'Done', 'Reply'])
  assert.equal(view.find({ type: 'Input' }), null)
  await clean(view)
})

test('the recommended option comes first, marked, and options past five fold behind "All N options"', async () => {
  const view = await open(MANY_OPTIONS)
  const order = ['Bun (recommended)', 'Node 20', 'Node 22', 'Deno']
  assert.deepEqual(texts(view, 'Button'), [...order, 'All 6 options', 'Reply', 'Dismiss'])
  assert.equal(view.find({ type: 'Button', text: 'Bun (recommended)' })?.props.variant, 'solid')
  assert.equal(view.find({ type: 'Button', text: 'Node 20' })?.props.variant, 'outline')
  await view.press({ type: 'Button', text: 'All 6 options' })
  assert.deepEqual(texts(view, 'Button'), [...order, 'Workers', 'Lambda', 'Reply', 'Dismiss'])
  await clean(view)
})

test("steps come after a question's options and before a task's Done, as the inbox's rowActions orders them", async () => {
  const view = await open(STEPS)
  assert.deepEqual(texts(view, 'Button'), [
    '4000',
    '8080',
    'Copy env line',
    'Reply',
    'Dismiss',
    'Run Friday check query',
    'Open runbook',
    'Done',
    'Reply',
  ])
  await clean(view)
})

test('a run step goes to the worker with its place and label; a link opens; a copy shows its text', async () => {
  const inputs: PressInput[] = []
  const host = mockHost({
    requests: {
      'inbox.view': () => STEPS,
      'inbox.press': (input: PressInput) => {
        inputs.push(input)
        return { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } }
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'Button', text: 'Run Friday check query' })
  assert.deepEqual(inputs.map(i => [i.id, i.action, i.step]), [['t1', 'step', { index: 0, label: 'Run Friday check query' }]])
  await view.press({ type: 'Button', text: 'Open runbook' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: 'https://example.com/runbook' }])
  assert.ok(view.find({ text: '✓ Opened runbook' }))
  await view.press({ type: 'Button', text: 'Copy env line' })
  assert.ok(view.find({ text: 'Select env line below to copy it' }))
  assert.equal(view.find({ type: 'CodeView' })?.props.code, 'PORT=4000')
  assert.equal(inputs.length, 1, 'local steps send nothing to the agent')
  await clean(view)
})

test('each group folds its closed items under "N closed", newest first, with "N earlier" past three', async () => {
  const view = await open(MANY_OPTIONS)
  assert.deepEqual(
    view.findAll({ type: 'Collapsible' }).map(c => c.props.title),
    ['5 closed', '1 closed'],
  )
  assert.equal(view.find({ text: '✓ Keep the lockfile?' }), null, 'the fold starts closed')
  const fold = view.findAll({ type: 'Collapsible' })[0]
  assert.ok(fold)
  await view.toggle(fold)
  assert.ok(view.find({ text: '✓ Keep the lockfile?' }))
  assert.ok(view.find({ text: '✕ Rename the repo?' }))
  assert.ok(view.find({ text: 'Pin the old parser?' }))
  assert.ok(view.find({ text: '2 earlier' }))
  // A group with no open rows still shows its title, its empty line and its closed fold.
  assert.ok(view.find({ text: 'Tasks · 0' }))
  assert.ok(view.find({ text: 'No open tasks' }))
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
  assert.deepEqual(texts(view, 'Button').slice(0, 2), ['Drop it (recommended)', 'Keep it'])
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

test('Reply opens a field on a question and on a task; Send sends the words, and Done sends done', async () => {
  const inputs: PressInput[] = []
  const view = await open(ONE_AGENT, input => {
    inputs.push(input)
    return { ok: true, label: input.action === 'answer' ? { text: 'Sending…', tone: 'muted', copy: null } : null }
  })
  const [questionReply, taskReply] = view.findAll({ type: 'Button', text: 'Reply' })
  assert.ok(questionReply && taskReply)
  await view.press(questionReply)
  await view.type({ type: 'Input', label: 'Your answer' }, 'Call it utils')
  await view.press({ type: 'Button', text: 'Send' })
  assert.equal(view.find({ type: 'Input', label: 'Your answer' }), null, 'the field closes once the reply is sent')
  await view.press(taskReply)
  await view.type({ type: 'Input', label: 'Your reply to Claude' }, 'Ran it, all green')
  await view.press({ type: 'Button', text: 'Send' })
  await view.press({ type: 'Button', text: 'Done' })
  assert.deepEqual(
    inputs.map(i => [i.id, i.action, i.answer]),
    [
      ['q1', 'answer', 'Call it utils'],
      ['t1', 'answer', 'Ran it, all green'],
      ['t1', 'done', undefined],
    ],
  )
  await clean(view)
})

test('Cancel closes the reply field and sends nothing', async () => {
  const inputs: PressInput[] = []
  const view = await open(ONE_AGENT, input => {
    inputs.push(input)
    return { ok: true, label: null }
  })
  await view.press({ type: 'Button', text: 'Reply' })
  assert.ok(view.find({ type: 'Input', label: 'Your answer' }))
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(view.find({ type: 'Input' }), null)
  assert.deepEqual(inputs, [])
  await clean(view)
})

test('a refused press shows why on its row', async () => {
  const view = await open(ONE_AGENT, input =>
    input.action === 'dismiss' ? { ok: false, refused: 'closed' } : { ok: false, refused: 'invalid' },
  )
  await view.press({ type: 'Button', text: 'No' })
  assert.ok(view.find({ text: 'Not sent' }))
  await view.press({ type: 'Button', text: 'Dismiss' })
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
  assert.ok(view.find({ text: '1) Rename the folder to tools?' }))
  await clean(view)
})
