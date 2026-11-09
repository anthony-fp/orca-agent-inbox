import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMPTY, applyUpdate, closeItem, parseReply } from './ledger'
import { OPTIONS_FOLD_AT, choices, findingRows, nowRows, rowCopyText, shortAgo, stepsOf } from './now'

const REPLY = [
  'NEW: decide | 1 | Rename greet.mjs to hello.mjs? | Yes / No | yes',
  'NEW: decide | 2 | Cut CHANGELOG.md down to this release? | - | -',
  'NEW: do | - | Test pinch zoom on your Mac | - | -',
].join('\n')

const ledger = applyUpdate({ ...EMPTY, turn: 1 }, parseReply(REPLY)!, 1000, 1)

const HOUR = 60 * 60 * 1000
const NONE = { shown: [], total: 0 }

test('an empty ledger has no rows', () => {
  assert.deepEqual(nowRows(EMPTY), { questions: [], tasks: [], closed: { questions: NONE, tasks: NONE } })
})

test('open questions keep their options and rec, number and age, and tasks come apart from questions', () => {
  const { questions, tasks } = nowRows(ledger, 1000 + 2 * HOUR)
  assert.deepEqual(questions, [
    {
      id: 'i1',
      handle: '1)',
      text: 'Rename greet.mjs to hello.mjs?',
      age: '2h',
      rec: 'Yes',
      choices: [
        { option: 'Yes', label: 'Yes', isRec: true, isFolded: false },
        { option: 'No', label: 'No', isRec: false, isFolded: false },
      ],
      steps: [],
      path: null,
    },
    { id: 'i2', handle: '2)', text: 'Cut CHANGELOG.md down to this release?', age: '2h', rec: null, choices: [], steps: [], path: null },
  ])
  assert.deepEqual(tasks, [
    { id: 'i3', handle: '', text: 'Test pinch zoom on your Mac', age: '2h', rec: null, choices: [], steps: [], path: null },
  ])
})

test('the recommended option comes first, and options past the limit fold after the fourth', () => {
  const options = ['A', 'B', 'C', 'D', 'E', 'F']
  const shown = choices({ options, rec: 'C' })
  assert.deepEqual(shown.map(c => c.option), ['C', 'A', 'B', 'D', 'E', 'F'])
  assert.deepEqual(shown.map(c => c.isRec), [true, false, false, false, false, false])
  assert.deepEqual(shown.map(c => c.isFolded), [false, false, false, false, true, true])
  // At the limit nothing folds; a rec that is not an option changes nothing.
  assert.ok(choices({ options: options.slice(0, OPTIONS_FOLD_AT), rec: 'Z' }).every(c => !c.isFolded && !c.isRec))
  assert.equal(choices({ options: ['x'.repeat(40)], rec: null })[0].label, `${'x'.repeat(31)}…`)
})

test("steps take the inbox's labels and kinds: a run hands off, and a copy joins an open", () => {
  const run = { kind: 'run' as const, command: 'psql -f checks/friday.sql', name: 'Friday check query' }
  const link = { kind: 'link' as const, url: 'https://example.com/runbook', name: null }
  assert.deepEqual(stepsOf([run, link]), [
    { label: 'Run Friday check query', kind: 'handoff', helps: [run] },
    { label: 'Open example.com', kind: 'local', helps: [link] },
  ])
  const copy = { kind: 'copy' as const, text: 'PORT=4000', name: 'env line' }
  const open = { kind: 'open' as const, path: 'config/.env' }
  assert.deepEqual(stepsOf([copy, open]), [{ label: 'Copy env line and open .env', kind: 'local', helps: [copy, open] }])
})

test('the age reads as the inbox shortAgo does', () => {
  assert.deepEqual([shortAgo(0), shortAgo(5 * 60_000), shortAgo(2 * HOUR), shortAgo(72 * HOUR)], ['now', '5m', '2h', '3d'])
})

test('the newest reply comes first', () => {
  const later = applyUpdate({ ...ledger, turn: 2 }, parseReply('NEW: decide | - | Push the branch? | - | -')!, 2000, 2)
  assert.deepEqual(
    nowRows(later).questions.map(r => r.id),
    ['i4', 'i1', 'i2'],
  )
})

test('closed items leave the open rows and show in their group, newest first, three at most', () => {
  const closed = closeItem(closeItem(ledger, 'i1', { how: 'answered', outcome: 'yes' }, 2000), 'i3', { how: 'done', outcome: 'done' }, 3000)
  const rows = nowRows(closed, 3000 + HOUR)
  assert.deepEqual(rows.questions.map(r => r.id), ['i2'])
  assert.deepEqual(rows.tasks, [])
  assert.deepEqual(rows.closed, {
    questions: { shown: [{ id: 'i1', mark: '✓', text: 'Rename greet.mjs to hello.mjs?', outcome: 'Yes', age: '1h' }], total: 1 },
    tasks: { shown: [{ id: 'i3', mark: '✓', text: 'Test pinch zoom on your Mac', outcome: 'Done', age: '1h' }], total: 1 },
  })
  let many = closed
  for (let n = 0; n < 4; n++) {
    many = applyUpdate({ ...many, turn: many.turn + 1 }, parseReply(`NEW: decide | - | Q${n}? | - | -`)!, 4000, many.turn + 1)
    many = closeItem(many, many.items.find(i => i.ask === `Q${n}?`)!.id, { how: 'dismissed', outcome: 'dismissed' }, 4000 + n)
  }
  const group = nowRows(many, 5000).closed.questions
  assert.equal(group.total, 5)
  assert.deepEqual(group.shown.map(c => [c.text, c.mark]), [['Q3?', '✕'], ['Q2?', '✕'], ['Q1?', '✕']])
})

// The inbox's 'a Fix sent for a finding a question had asked about reads the fix label on its closed row'
// (tests/hooks.test.ts, commit 2d4bd27).
test('a Fix sent for a finding a question had asked about reads the fix label on its closed row', () => {
  const at = 1_000_000
  const asked = { id: 'f90', kind: 'issue' as const, title: 'Retry', detail: 'No delay.', path: null, at, askedAs: 'i2' }
  const rows = findingRows({ ...EMPTY, findings: [asked], closedFindings: [] }, at, { f90: at })
  assert.deepEqual(rows.closed.issues.shown.map(f => [f.id, f.outcome]), [['f90', 'Fix']])
})

test('Copy on a finding writes its title in bold, its detail and its file as Markdown', () => {
  const text = rowCopyText({ kind: 'finding', title: 'The retry loop never backs off', detail: 'Each retry fires at once.', path: 'src/fetch.ts' })
  assert.equal(text, '**The retry loop never backs off**\n\nEach retry fires at once.\n\nFile: `src/fetch.ts`')
  const open = findingRows({ ...EMPTY, findings: [{ id: 'f1', kind: 'issue', title: 'T', detail: 'D', path: '/repo/src/a.ts', at: 0 }] }, 0, {})
  assert.deepEqual([open.issues[0]?.path, open.issues[0]?.fileName], ['/repo/src/a.ts', 'a.ts'], 'a finding row keeps its whole path for Copy')
})

test('Copy on a question with only its ask writes the ask in bold and nothing else', () => {
  assert.equal(rowCopyText({ kind: 'question', title: 'Rename greet.mjs to hello.mjs?' }), '**Rename greet.mjs to hello.mjs?**')
})

test('Copy on a question with a path writes the File line, and the row keeps the whole path', () => {
  const item = { id: 'i1', kind: 'question' as const, label: null, ask: 'Keep the retry?', options: ['Yes'], rec: null, helps: [], turn: 0, at: 0, from: 'record' as const, path: '/repo/src/fetch.ts' }
  const row = nowRows({ ...EMPTY, items: [item] }, 0).questions[0]!
  assert.equal(row.path, '/repo/src/fetch.ts')
  assert.equal(rowCopyText({ kind: 'question', title: row.text, path: row.path }), '**Keep the retry?**\n\nFile: `/repo/src/fetch.ts`')
})

test("Copy on a task with terminal steps writes only their commands, one per line; other steps don't count", () => {
  const steps = stepsOf([
    { kind: 'terminal', command: 'npm run migrate', name: 'migration' },
    { kind: 'link', url: 'https://example.com/runbook', name: 'runbook' },
    { kind: 'terminal', command: 'npm run seed', name: null },
  ])
  assert.equal(rowCopyText({ kind: 'task', title: 'Migrate staging', steps }), 'npm run migrate\nnpm run seed')
  const noTerminal = stepsOf([{ kind: 'run', command: 'npm test', name: null }])
  assert.equal(rowCopyText({ kind: 'task', title: 'Run the tests', steps: noTerminal }), '**Run the tests**')
  // Only a task copies commands: a question with a terminal step copies its Markdown block.
  assert.equal(rowCopyText({ kind: 'question', title: 'Migrate now?', steps }), '**Migrate now?**')
})
