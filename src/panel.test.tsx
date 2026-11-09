// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { parsePlan } from './core/plan'
import { CLOSED_FINDINGS, CODEX_ONLY, EMPTY_VIEW, FINDINGS, MANY_OPTIONS, MIXED, ONE_AGENT, PLAN, STEPS, THREE_AGENTS, row, section } from './panel-views'
import type { InboxView } from './protocol'
import type { PressInput, PressOutcome } from './presses'

const texts = (view: Awaited<ReturnType<typeof mount>>, type: string) =>
  view.findAll({ type }).map(e => e.text)

async function open(view: InboxView, press?: (input: PressInput) => PressOutcome | Promise<PressOutcome>) {
  const host = mockHost({ requests: { 'inbox.view': () => view, ...(press ? { 'inbox.press': press } : {}) } })
  return mount(panel, { host })
}

/** A label's Copy, which copies the text a press left: an extra-small button, unlike each row's own Copy. */
const labelCopies = (view: Awaited<ReturnType<typeof mount>>) =>
  view.findAll({ type: 'Button', text: 'Copy' }).filter(b => b.props.size === 'xs')

const NO_TOOLS = /^No tools: /
const UNTRACKED_CODEX = 'Started before Agent Inbox; not tracked.'

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
  const view = await open({ sections: [section(1), section(2)], others: [], untracked: 0, unread: 0 })
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
  // The inbox's rowActions (hooks/view.ts), then Explain and Copy before Dismiss: question options, Reply, Explain,
  // Copy, Dismiss; task Done, Reply, Explain, Copy. No field until Reply.
  assert.deepEqual(texts(view, 'Button'), ['Yes', 'No', 'Reply', 'Explain', 'Copy', 'Dismiss', 'Done', 'Reply', 'Explain', 'Copy'])
  assert.equal(view.find({ type: 'Input' }), null)
  await clean(view)
})

test('the recommended option comes first, marked, and options past five fold behind "All N options"', async () => {
  const view = await open(MANY_OPTIONS)
  const order = ['Bun (recommended)', 'Node 20', 'Node 22', 'Deno']
  assert.deepEqual(texts(view, 'Button'), [...order, 'All 6 options', 'Reply', 'Explain', 'Copy', 'Dismiss'])
  assert.equal(view.find({ type: 'Button', text: 'Bun (recommended)' })?.props.variant, 'solid')
  assert.equal(view.find({ type: 'Button', text: 'Node 20' })?.props.variant, 'outline')
  await view.press({ type: 'Button', text: 'All 6 options' })
  assert.deepEqual(texts(view, 'Button'), [...order, 'Workers', 'Lambda', 'Reply', 'Explain', 'Copy', 'Dismiss'])
  await clean(view)
})

test("steps come after a question's options and before a task's Done, as the inbox's rowActions orders them", async () => {
  const view = await open(STEPS)
  assert.deepEqual(texts(view, 'Button'), [
    '4000',
    '8080',
    'Copy env line',
    'Reply',
    'Explain',
    'Copy',
    'Dismiss',
    'Run Friday check query',
    'Open runbook',
    'Done',
    'Reply',
    'Explain',
    'Copy',
  ])
  await clean(view)
})

test('a run step goes to the worker with its place and label; a link opens; a copy goes to the clipboard', async () => {
  const inputs: PressInput[] = []
  const copied: string[] = []
  const host = mockHost({
    requests: {
      'inbox.view': () => STEPS,
      'inbox.press': (input: PressInput) => {
        inputs.push(input)
        return { ok: true, label: { text: 'Sending…', tone: 'muted', copy: null } }
      },
      'inbox.copy': (input: { text: string }) => {
        copied.push(input.text)
        return { ok: true }
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
  assert.deepEqual(copied, ['PORT=4000'])
  assert.ok(view.find({ text: '✓ Copied env line' }))
  assert.equal(view.find({ type: 'CodeView' }), null, 'nothing to select once the clipboard has it')
  assert.equal(inputs.length, 1, 'local steps send nothing to the agent')
  await clean(view)
})

test('a copy step the worker cannot copy shows its text to select', async () => {
  const host = mockHost({ requests: { 'inbox.view': () => STEPS, 'inbox.copy': () => ({ ok: false, error: 'no clipboard command on this system' }) } })
  const view = await mount(panel, { host })
  await view.press({ type: 'Button', text: 'Copy env line' })
  assert.ok(view.find({ text: 'Select env line below to copy it' }))
  assert.equal(view.find({ type: 'CodeView' })?.props.code, 'PORT=4000')
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
  assert.equal(labelCopies(view).length, 2)
  await clean(view)
})

test('Copy writes the clipboard through the worker and reads "✓ Copied"', async () => {
  const copied: string[] = []
  const host = mockHost({
    requests: {
      'inbox.view': () => THREE_AGENTS,
      'inbox.copy': (input: { text: string }) => {
        copied.push(input.text)
        return { ok: true }
      },
    },
  })
  const view = await mount(panel, { host })
  const [first] = labelCopies(view)
  assert.ok(first)
  await view.press(first)
  assert.deepEqual(copied, ['Re "Which port should the dev server use?": 4000'])
  assert.equal(view.findAll({ text: '✓ Copied' }).length, 1, 'only the pressed label reads it')
  assert.equal(view.find({ type: 'CodeView' }), null)
  await clean(view)
})

test('a Copy the worker cannot do shows the answer text to select, and Hide closes it', async () => {
  const host = mockHost({ requests: { 'inbox.view': () => THREE_AGENTS, 'inbox.copy': () => ({ ok: false, error: 'no clipboard command on this system' }) } })
  const view = await mount(panel, { host })
  const [first] = labelCopies(view)
  assert.ok(first)
  await view.press(first)
  assert.equal(view.find({ text: '✓ Copied' }), null)
  const code = view.find({ type: 'CodeView' })
  assert.equal(code?.props.code, 'Re "Which port should the dev server use?": 4000')
  assert.equal(code?.props.label, 'Could not copy: select the text to copy it')
  await view.press({ type: 'Button', text: 'Hide' })
  assert.equal(view.find({ type: 'CodeView' }), null)
  await clean(view)
})

/** Mounts a view whose `inbox.copy` records each text and answers with `answer`. */
async function withCopy(view: InboxView, answer: { ok: true } | { ok: false; error: string } = { ok: true }) {
  const copied: string[] = []
  const host = mockHost({ requests: { 'inbox.view': () => view, 'inbox.copy': (input: { text: string }) => (copied.push(input.text), answer) } })
  return { view: await mount(panel, { host }), copied }
}

/** Each row kind's own Copy: a small outline button, unlike a label's extra-small one. */
const rowCopies = (view: Awaited<ReturnType<typeof mount>>) =>
  view.findAll({ type: 'Button', text: 'Copy' }).filter(b => b.props.size === 'sm')

test('Copy on a row writes its Markdown block, or a task\'s terminal commands, through the worker and reads "✓ Copied"', async () => {
  const commands = row('t2', 'Migrate staging', {
    helps: [
      { kind: 'terminal', command: 'npm run migrate', name: 'migration' },
      { kind: 'terminal', command: 'npm run seed', name: 'seed' },
    ],
  })
  const [s] = FINDINGS.sections
  const { view, copied } = await withCopy({ ...FINDINGS, sections: [{ ...s, questions: [row('q1', 'Keep the old parser?')], tasks: [commands] }] })
  const copies = rowCopies(view)
  assert.equal(copies.length, 4, 'a question, a task and two findings each have Copy')
  for (const button of copies) await view.press(button)
  assert.deepEqual(copied, [
    '**Keep the old parser?**',
    'npm run migrate\nnpm run seed',
    '**The retry loop never backs off**\n\nEach retry fires at once, so a down server gets a flood.\n\nFile: `src/fetch.ts`',
    '**Cache the parsed config**\n\nFound while working on the task.',
  ])
  const done = view.findAll({ text: '✓ Copied' })
  assert.equal(done.length, 4, 'each row reads it')
  assert.equal(done[0]?.props.tone, 'success')
  await clean(view)
})

test('Open shows only on rows with a path, after Explain and before Copy, and asks the worker to open the file', async () => {
  const opened: { sessionId: string; path: string }[] = []
  let finish = (_out: { ok: true } | { ok: false; error: string }) => {}
  const host = mockHost({
    requests: {
      'inbox.view': () => ({
        ...ONE_AGENT,
        sections: [section(1, { questions: [row('q1', 'Keep the old parser?', { path: 'src/parse.ts' })], tasks: [row('t1', 'Run the migration')] })],
      }),
      'inbox.openFile': (input: { sessionId: string; path: string }) => (opened.push(input), new Promise(r => (finish = r))),
    },
  })
  const view = await mount(panel, { host })
  assert.deepEqual(texts(view, 'Button'), ['Reply', 'Explain', 'Open', 'Copy', 'Dismiss', 'Done', 'Reply', 'Explain', 'Copy'])
  const pressing = view.press({ type: 'Button', text: 'Open' })
  await new Promise(r => setTimeout(r, 0))
  assert.ok(view.find({ text: 'Opening parse.ts…' }))
  finish({ ok: true })
  await pressing
  assert.deepEqual(opened, [{ sessionId: 'session-1', path: 'src/parse.ts' }])
  assert.equal(view.find({ text: '✓ Opened parse.ts' })?.props.tone, 'success')
  await clean(view)
})

test('an Open the worker cannot do shows its error in red on the row', async () => {
  const host = mockHost({
    requests: {
      'inbox.view': () => ({ ...ONE_AGENT, sections: [section(1, { tasks: [row('t1', 'Fix the parser', { path: '/etc/hosts' })] })] }),
      'inbox.openFile': () => ({ ok: false, error: 'File is outside this workspace' }),
    },
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'Button', text: 'Open' })
  assert.equal(view.find({ text: 'File is outside this workspace' })?.props.tone, 'danger')
  await clean(view)
})

test('an open step opens the file through the worker, and copies nothing', async () => {
  const opened: string[] = []
  const copied: string[] = []
  const host = mockHost({
    requests: {
      'inbox.view': () => ({ ...ONE_AGENT, sections: [section(1, { tasks: [row('t1', 'Read the parser', { helps: [{ kind: 'open', path: 'src/parse.ts' }] })] })] }),
      'inbox.openFile': (input: { path: string }) => (opened.push(input.path), { ok: true }),
      'inbox.copy': (input: { text: string }) => (copied.push(input.text), { ok: true }),
    },
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'Button', text: 'Open parse.ts' })
  assert.deepEqual(opened, ['src/parse.ts'])
  assert.deepEqual(copied, [])
  assert.ok(view.find({ text: '✓ Opened parse.ts' }))
  await clean(view)
})

test('a Copy the worker cannot do shows why in red on the row, and the text to select', async () => {
  const { view, copied } = await withCopy(ONE_AGENT, { ok: false, error: 'no clipboard tool worked (tried wl-copy, xclip, xsel)' })
  const [copy] = rowCopies(view)
  assert.ok(copy)
  await view.press(copy)
  assert.deepEqual(copied, ['**Rename the folder to tools?**'])
  assert.equal(view.find({ text: '✓ Copied' }), null)
  const why = view.find({ text: 'Could not copy: no clipboard tool worked (tried wl-copy, xclip, xsel)' })
  assert.equal(why?.props.tone, 'danger')
  assert.equal(view.find({ type: 'CodeView' })?.props.code, '**Rename the folder to tools?**')
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
  assert.equal(labelCopies(view).length, 1)
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
      // Typed words go as `reply`, which never closes the row at once: the inbox model decides.
      ['q1', 'reply', 'Call it utils'],
      ['t1', 'reply', 'Ran it, all green'],
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

test('a workspace change, as on a focus change, asks for the view again', async () => {
  let current: InboxView = EMPTY_VIEW
  const host = mockHost({ requests: { 'inbox.view': () => current } })
  const view = await mount(panel, { host })
  current = ONE_AGENT
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'two', terminals: [] } })
  assert.ok(view.find({ text: '1) Rename the folder to tools?' }))
  await clean(view)
})

test("a row's age never shrinks, so a narrow panel keeps it on one line", async () => {
  for (const v of [ONE_AGENT, FINDINGS, THREE_AGENTS]) {
    const view = await open(v)
    const ages = view.findAll({ type: 'Text' }).filter(t => /^(now|\d+[smhd])$/.test(t.text)).map(t => t.text)
    const kept = view.findAll({ type: 'Box' }).filter(b => b.props.shrink === false).map(b => b.text)
    assert.ok(ages.length > 0)
    assert.deepEqual(kept, ages)
    await clean(view)
  }
})

test('findings: Issues and Opportunities after Tasks, each row with its mark, detail, file and the inbox finding buttons', async () => {
  const view = await open(FINDINGS)
  const groups = texts(view, 'Text').filter(t => / · \d+$/.test(t))
  assert.deepEqual(groups, ['Tasks · 1', 'Issues · 1', 'Opportunities · 1'])
  assert.ok(view.find({ text: '▲' }))
  assert.ok(view.find({ text: 'The retry loop never backs off' }))
  assert.ok(view.find({ text: 'Each retry fires at once, so a down server gets a flood.' }))
  assert.ok(view.find({ text: 'Relevant file: fetch.ts' }))
  assert.ok(view.find({ text: '✦' }))
  // The inbox's actionsOf (hooks/view.ts) less Discuss: Fix or Do it, File issue, Reply, Explain, Dismiss. Open only on the row with a path.
  assert.deepEqual(texts(view, 'Button'), [
    'Done', 'Reply', 'Explain', 'Copy',
    'Fix', 'File issue', 'Reply', 'Explain', 'Open', 'Copy', 'Dismiss',
    'Do it', 'File issue', 'Reply', 'Explain', 'Copy', 'Dismiss',
  ])
  assert.equal(view.find({ type: 'Button', text: 'Fix' })?.props.variant, 'solid')
  assert.deepEqual(view.findAll({ type: 'Collapsible' }).map(c => c.props.title), ['1 closed'])
  await clean(view)
})

test('Explain goes to the worker with the row\'s id, reads "Explaining…" while out, and reads "Explain again" on an explained row', async () => {
  const inputs: PressInput[] = []
  const view = await open(FINDINGS, input => {
    inputs.push(input)
    return { ok: true, label: { text: 'Explaining…', tone: 'muted', copy: null } }
  })
  for (const button of view.findAll({ type: 'Button', text: 'Explain' })) await view.press(button)
  assert.deepEqual(inputs.map(i => [i.id, i.action]), [['t1', 'explain'], ['i4', 'explain'], ['i5', 'explain']])
  assert.ok(view.find({ text: 'Explaining…' }))
  await clean(view)

  const [s] = FINDINGS.sections
  const explained: InboxView = {
    ...FINDINGS,
    sections: [{ ...s, tasks: s.tasks.map(r => ({ ...r, explained: true })), findings: { ...s.findings, issues: s.findings.issues.map(f => ({ ...f, explained: true })) } }],
  }
  const again = await open(explained)
  assert.deepEqual(texts(again, 'Button').filter(t => t.startsWith('Explain')), ['Explain again', 'Explain again', 'Explain'])
  await clean(again)
})

test('findings with only closed ones: both groups show their empty lines and "N closed"', async () => {
  const view = await open(CLOSED_FINDINGS)
  assert.ok(view.find({ text: 'Issues · 0' }))
  assert.ok(view.find({ text: 'No open issues' }))
  assert.ok(view.find({ text: 'Opportunities · 0' }))
  assert.ok(view.find({ text: 'No open opportunities' }))
  assert.deepEqual(view.findAll({ type: 'Collapsible' }).map(c => c.props.title), ['1 closed'])
  assert.equal(view.find({ text: 'Nothing waits on you.' }), null)
  await clean(view)
})

test("a finding's Fix, File issue, Reply and Dismiss go to the worker with the finding's id", async () => {
  const inputs: PressInput[] = []
  const view = await open(FINDINGS, input => {
    inputs.push(input)
    return { ok: true, label: input.action === 'dismiss' ? null : { text: 'Sending…', tone: 'muted', copy: null } }
  })
  await view.press({ type: 'Button', text: 'Fix' })
  await view.press({ type: 'Button', text: 'Do it' })
  const fileIssue = view.findAll({ type: 'Button', text: 'File issue' })[0]
  assert.ok(fileIssue)
  await view.press(fileIssue)
  const reply = view.findAll({ type: 'Button', text: 'Reply' })[1]
  assert.ok(reply)
  await view.press(reply)
  await view.type({ type: 'Input', label: 'Your reply to Claude' }, 'Use a jitter')
  await view.press({ type: 'Button', text: 'Send' })
  const dismiss = view.findAll({ type: 'Button', text: 'Dismiss' })[1]
  assert.ok(dismiss)
  await view.press(dismiss)
  assert.deepEqual(
    inputs.map(i => [i.id, i.action, i.answer]),
    [
      ['i4', 'fix', undefined],
      ['i5', 'fix', undefined],
      ['i4', 'issue', undefined],
      ['i4', 'reply', 'Use a jitter'],
      ['i5', 'dismiss', undefined],
    ],
  )
  await clean(view)
})

test('plan: "PLAN N of M steps", a progress bar, and one fold per task; a task with a step in progress starts open', async () => {
  const view = await open(PLAN)
  assert.ok(view.find({ text: 'PLAN  3 of 6 steps' }))
  assert.equal(view.find({ type: 'Progress' })?.props.value, 50)
  assert.deepEqual(
    view.findAll({ type: 'Collapsible' }).map(c => [c.props.title, c.props.open]),
    [
      ['Write the fix  1/3', true],
      ['Ship it  0/1', false],
      ['Completed (1)', false],
    ],
  )
  const current = view.find({ text: '◐ Change the parser' })
  assert.equal(current?.props.weight, 'semibold')
  assert.equal(current?.props.tone, 'accent')
  assert.equal(view.find({ text: '✓ Add a failing test' })?.props.tone, 'success')
  assert.ok(view.find({ text: '○ Run the suite' }))
  assert.equal(view.find({ text: '○ Open the PR' }), null, 'a closed task lists no steps')
  assert.equal(view.find({ text: 'Nothing waits on you.' }), null)
  await clean(view)
})

test('plan: groups keep source order across completion and reopening, with Completed collapsed per session', async () => {
  const source = '## A\n- [x] a\n## B\n- [ ] b\n## C\n- [x] c\n## D\n- [~] d\n- [ ] e'
  let current: InboxView = { sections: [section(1, { plan: parsePlan(source) })], others: [], untracked: 0, unread: 0 }
  const host = mockHost({ requests: { 'inbox.view': () => current } })
  const view = await mount(panel, { host })
  const folds = () => view.findAll({ type: 'Collapsible' })
  const titles = () => folds().map(c => c.props.title)
  const fold = (title: string) => {
    const found = view.find({ type: 'Collapsible', label: title })
    assert.ok(found, title)
    return found
  }
  assert.deepEqual(titles(), ['B  0/1', 'D  0/2', 'Completed (2)'])
  assert.equal(fold('Completed (2)').props.open, false)
  await view.toggle(fold('B  0/1'))
  await view.toggle(fold('Completed (2)'))
  assert.deepEqual(titles(), ['B  0/1', 'D  0/2', '✓ A  1/1', '✓ C  1/1'])
  current.sections[0]!.plan = parsePlan(source.replace('[ ] b', '[x] b'))
  await view.post('inbox.changed', {})
  assert.deepEqual(titles(), ['D  0/2', '✓ A  1/1', 'B  1/1', '✓ C  1/1'])
  assert.equal(fold('B  1/1').props.open, true, 'grouping preserves the original task key and open choice')
  current.sections[0]!.plan = parsePlan(source)
  await view.post('inbox.changed', {})
  assert.deepEqual(titles(), ['B  0/1', 'D  0/2', '✓ A  1/1', '✓ C  1/1'])
  assert.equal(fold('B  0/1').props.open, true)
  await view.toggle(fold('Completed (2)'))
  assert.deepEqual(titles(), ['B  0/1', 'D  0/2', 'Completed (2)'])
  current = { sections: [section(2, { plan: parsePlan('## A\n- [x] a') })], others: [], untracked: 0, unread: 0 }
  await view.post('inbox.changed', {})
  assert.deepEqual(titles(), ['Completed (1)'])
  assert.equal(fold('Completed (1)').props.open, false)
  assert.equal(view.find({ text: 'Active' }), null)
  await view.toggle(fold('Completed (1)'))
  assert.deepEqual(titles(), ['✓ A  1/1'])
  await clean(view)
})

test("plan: a plan file that cannot be read shows the skill's one error line, in the danger tone", async () => {
  const view = await open({ sections: [section(1, { planError: '/work/.claude/plans/s.md' })], others: [], untracked: 0, unread: 0 })
  assert.equal(view.find({ text: 'Could not read the plan: /work/.claude/plans/s.md' })?.props.tone, 'danger')
  assert.equal(view.find({ type: 'Progress' }), null)
  assert.equal(view.find({ type: 'EmptyState', label: 'Nothing waits on you' }), null)
  await clean(view)
})

test('plan: a press toggles a task, and the choice stays across a new view', async () => {
  const host = mockHost({ requests: { 'inbox.view': () => PLAN } })
  const view = await mount(panel, { host })
  const fold = (title: string) => view.findAll({ type: 'Collapsible' }).find(c => c.props.title === title)
  const ship = fold('Ship it  0/1')
  assert.ok(ship)
  await view.toggle(ship)
  assert.ok(view.find({ text: '○ Open the PR' }))
  const fix = fold('Write the fix  1/3')
  assert.ok(fix)
  await view.toggle(fix)
  assert.equal(view.find({ text: '◐ Change the parser' }), null)
  await view.post('inbox.changed', {})
  assert.equal(fold('Ship it  0/1')?.props.open, true)
  assert.equal(fold('Write the fix  1/3')?.props.open, false)
  await clean(view)
})

test('a launch with no tools says so; an untracked Codex agent gets its own note', async () => {
  const view = await open(MIXED)
  assert.deepEqual(texts(view, 'Heading'), ['Agent 1', 'Codex'])
  assert.ok(view.find({ text: NO_TOOLS }))
  assert.ok(view.find({ text: UNTRACKED_CODEX }))
  await clean(view)
})

test('an untracked Codex agent has its title and the untracked note', async () => {
  const view = await open(CODEX_ONLY)
  assert.deepEqual(texts(view, 'Heading'), ['Codex'])
  assert.ok(view.find({ text: UNTRACKED_CODEX }))
  assert.equal(view.find({ type: 'EmptyState' }), null)
  assert.equal(view.find({ text: NO_TOOLS }), null)
  await clean(view)
})

test('a Codex pane awaiting its first prompt explains how to start tracking', async () => {
  const view = await open({ ...CODEX_ONLY, others: [{ key: 'codex-pane', title: 'Codex', agent: 'codex', reason: 'launch-unmatched' }] })
  assert.ok(view.find({ text: 'Send a prompt in this Codex pane to start tracking it.' }))
  await clean(view)
})

test('a tracked Codex agent uses the same rows and buttons as Claude', async () => {
  const codex = { ...ONE_AGENT, sections: ONE_AGENT.sections.map(s => ({ ...s, agent: 'codex' as const, title: 'Codex' })) }
  const view = await open(codex)
  assert.deepEqual(texts(view, 'Heading'), ['Codex'])
  assert.ok(view.find({ text: '1) Rename the folder to tools?' }))
  assert.ok(view.find({ text: 'Run the migration on staging' }))
  assert.deepEqual(texts(view, 'Button'), ['Yes', 'No', 'Reply', 'Explain', 'Copy', 'Dismiss', 'Done', 'Reply', 'Explain', 'Copy'])
  assert.equal(view.find({ text: UNTRACKED_CODEX }), null)
  await clean(view)
})

test('an untrusted tracked Codex launch shows the hook instruction in its section', async () => {
  const section = { ...ONE_AGENT.sections[0], title: 'Codex', agent: 'codex' as const, trustHook: true }
  const view = await open({ sections: [section], others: [], untracked: 0, unread: 0 })
  assert.ok(view.find({ text: 'Trust the Agent Inbox hook in Codex to send answers' }))
  assert.deepEqual(texts(view, 'Heading'), ['Codex'])
  assert.ok(view.find({ type: 'Button', text: 'Copy Yes' }))
  assert.ok(view.find({ type: 'Button', text: 'Copy No' }))
  await clean(view)
})

test('a section whose launch got tools has no "No tools" line', async () => {
  const view = await open(ONE_AGENT)
  assert.equal(view.find({ text: NO_TOOLS }), null)
  await clean(view)
})
