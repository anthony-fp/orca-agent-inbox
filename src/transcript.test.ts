// readTurn over the hand-written fixtures in src/fixtures/, which copy the shapes in docs/transcript-format.md.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { promptsBefore, readTurn } from './transcript'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name))

/** Every turn in a file, read one after another as the turn tracker would. */
function walk(bytes: Buffer) {
  const turns = []
  for (let offset = 0, read = readTurn(bytes, 0); read; read = readTurn(bytes, offset)) {
    turns.push(read)
    if (read.status === 'pending') break
    offset = read.nextOffset
  }
  return turns
}

test('a plain turn is complete, with the prompt, the reply and no activity', () => {
  const bytes = fixture('plain.jsonl')
  const read = readTurn(bytes, 0)
  assert.equal(read?.status, 'complete')
  assert.equal(read?.turnId, 'p-1')
  assert.deepEqual(read?.exchange, {
    person: 'What does the parser do?',
    trigger: null,
    activity: [],
    reply: 'It reads one line at a time.',
    turn: 1,
    press: null,
    screen: '',
  })
  assert.equal(read?.nextOffset, bytes.length)
  assert.equal(readTurn(bytes, bytes.length), null)
})

test('a tool turn lists each call as the inbox mod does, and replies with the text after the last call', () => {
  const read = readTurn(fixture('tools.jsonl'), 0)
  assert.equal(read?.status, 'complete')
  assert.deepEqual(read?.exchange.activity, [
    'started in background: npm run dev',
    'URL in output: http://localhost:5173/',
    'edited src/title.ts',
    'called tracker__get_issue',
  ])
  assert.equal(read?.exchange.reply, 'The server runs and the title is fixed.')
})

test('a turn is pending while a tool call is open, or while the last text goes on to a tool call', () => {
  const text = fixture('tools.jsonl').toString()
  const cut = (lines: number) => text.split('\n').slice(0, lines).join('\n') + '\n'
  assert.equal(readTurn(cut(2), 0)?.status, 'pending') // text with stop_reason tool_use
  assert.equal(readTurn(cut(3), 0)?.status, 'pending') // the Bash call has no result
  const pending = readTurn(cut(7), 0) // the mcp call has no result
  assert.equal(pending?.status, 'pending')
  assert.equal(pending?.nextOffset, 0)
  assert.equal(pending?.exchange.reply, '')
})

test('a dialog shows its questions and how it ended: answered, dismissed, still open', () => {
  const [answered, dismissed, open] = walk(fixture('dialog.jsonl'))
  assert.equal(answered.status, 'complete')
  assert.deepEqual(answered.exchange.activity, [
    `asked the user in a dialog: "Which database?" (options: Postgres (recommended) / SQLite); answer: User has answered your questions: "Which database?"="SQLite".`,
  ])
  assert.equal(answered.exchange.reply, 'SQLite it is.')

  // Sent by a plugin as the person's words, then dismissed and interrupted with no reply.
  assert.equal(dismissed.status, 'incomplete')
  assert.equal(dismissed.exchange.person, 'Now add the schema.')
  assert.equal(dismissed.exchange.turn, 2)
  assert.deepEqual(dismissed.exchange.activity, [
    'asked the user in a dialog: "Which tables?" (options: users); the user dismissed it without answering',
  ])
  assert.equal(dismissed.exchange.reply, '')

  // Another agent started the turn, so it has a trigger and no person.
  assert.equal(open.status, 'pending')
  assert.equal(open.exchange.person, null)
  assert.equal(open.exchange.trigger, 'peer')
  assert.equal(open.exchange.turn, 2)
  assert.deepEqual(open.exchange.activity, [
    `asked the user in a dialog: "Reply to it?" (options: Yes); still open, waiting on the user's answer`,
  ])
})

test('a half-written last line is never parsed', () => {
  const bytes = fixture('half-written.jsonl')
  const read = readTurn(bytes, 0)
  assert.equal(read?.status, 'pending')
  assert.equal(read?.exchange.reply, '')
  // The same turn completes once the line is whole.
  const whole = fixture('plain.jsonl')
  assert.ok(whole.subarray(0, bytes.length).equals(bytes))
  assert.equal(readTurn(whole, 0)?.status, 'complete')
})

test('an interrupted turn is incomplete once a later prompt comes, and the next turn reads on from that prompt', () => {
  const bytes = fixture('interrupted.jsonl')
  const first = readTurn(bytes, 0)
  assert.equal(first?.status, 'incomplete')
  assert.equal(first?.turnId, 'p-1')
  assert.deepEqual(first?.exchange.activity, ['ran: npm test'])
  assert.equal(first?.exchange.reply, '')
  assert.equal(bytes.toString('utf8', first?.nextOffset).startsWith('{"type":"user","uuid":"p-2"'), true)

  const second = readTurn(bytes, first!.nextOffset, first!.exchange.turn)
  assert.equal(second?.status, 'complete')
  assert.equal(second?.turnId, 'p-2')
  assert.equal(second?.exchange.person, 'Only the unit tests, please.')
  assert.equal(second?.exchange.turn, 2)
  assert.equal(second?.exchange.reply, 'The unit tests pass.')
})

test('compaction lines start no turn, and the prompt count carries across them', () => {
  const bytes = fixture('compaction.jsonl')
  const turns = walk(bytes)
  assert.deepEqual(
    turns.map(t => [t.turnId, t.status, t.exchange.turn, t.exchange.reply]),
    [
      ['p-1', 'complete', 1, 'The plan has three steps.'],
      ['p-2', 'complete', 2, 'Step one is done.'],
    ],
  )
  assert.equal(promptsBefore(bytes, turns[1].nextOffset), 2)
})

test('sidechain lines are skipped: a subagent prompt starts no turn, and its calls and text stay out', () => {
  const read = readTurn(fixture('sidechain.jsonl'), 0)
  assert.equal(read?.status, 'complete')
  assert.deepEqual(read?.exchange.activity, ['started agent: Find slow query'])
  assert.equal(read?.exchange.reply, 'The report job runs the slow query.')
})

test('a task notification that starts a turn is its trigger; one inside a turn is not', () => {
  const tools = readTurn(fixture('tools.jsonl'), 0)
  assert.equal(tools?.exchange.person, 'Start the dev server and fix the title.')
  const line = (o: object) => JSON.stringify({ sessionId: 's-1', isSidechain: false, ...o }) + '\n'
  const text =
    line({ type: 'user', uuid: 'n-1', origin: { kind: 'task-notification' }, turnOrigin: 'task_notification', turnPosition: { promptIndex: 0, turnIndex: 1 }, message: { role: 'user', content: '<task-notification>x</task-notification>' } }) +
    line({ type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }], stop_reason: 'end_turn' } })
  const read = readTurn(text, 0)
  assert.equal(read?.exchange.person, null)
  assert.equal(read?.exchange.trigger, 'task-notification')
  assert.equal(read?.exchange.turn, 0)
  assert.equal(read?.status, 'complete')
})

test('an API error line is not a reply', () => {
  const line = (o: object) => JSON.stringify({ sessionId: 's-1', isSidechain: false, ...o }) + '\n'
  const text =
    line({ type: 'user', uuid: 'p-1', origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'Hi' } }) +
    line({ type: 'assistant', uuid: 'a-1', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], stop_reason: 'stop_sequence' } })
  assert.equal(readTurn(text, 0)?.status, 'pending')
})
