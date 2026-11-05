import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMPTY, applyUpdate, closeItem, parseReply } from './ledger'
import { nowRows } from './now'

const REPLY = [
  'NEW: decide | 1 | Rename greet.mjs to hello.mjs? | Yes / No | yes',
  'NEW: decide | 2 | Cut CHANGELOG.md down to this release? | - | -',
  'NEW: do | - | Test pinch zoom on your Mac | - | -',
].join('\n')

const ledger = applyUpdate({ ...EMPTY, turn: 1 }, parseReply(REPLY)!, 1000, 1)

test('an empty ledger has no rows', () => {
  assert.deepEqual(nowRows(EMPTY), { questions: [], tasks: [] })
})

test('open questions keep their options, and tasks come apart from questions', () => {
  assert.deepEqual(nowRows(ledger), {
    questions: [
      { id: 'i1', text: 'Rename greet.mjs to hello.mjs?', options: ['Yes', 'No'] },
      { id: 'i2', text: 'Cut CHANGELOG.md down to this release?', options: [] },
    ],
    tasks: [{ id: 'i3', text: 'Test pinch zoom on your Mac', options: [] }],
  })
})

test('the newest reply comes first', () => {
  const later = applyUpdate({ ...ledger, turn: 2 }, parseReply('NEW: decide | - | Push the branch? | - | -')!, 2000, 2)
  assert.deepEqual(
    nowRows(later).questions.map(r => r.id),
    ['i4', 'i1', 'i2'],
  )
})

test('closed items are left out', () => {
  const closed = closeItem(closeItem(ledger, 'i1', { how: 'answered', outcome: 'Yes' }, 2000), 'i3', { how: 'done', outcome: 'done' }, 2000)
  const rows = nowRows(closed)
  assert.deepEqual(rows.questions.map(r => r.id), ['i2'])
  assert.deepEqual(rows.tasks, [])
})
