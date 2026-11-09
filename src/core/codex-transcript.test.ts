import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ORCA, ORCA_CODEX, systemText } from './model-text'
import { codexResumeStart, codexToolTurn, readCodexTurn, readRollout, rolloutFor, turnIn } from './codex-transcript'

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', `codex-${name}.jsonl`)
const temporary = () => mkdtempSync(join(tmpdir(), 'inbox-codex-test-'))
const row = (payload: object, type = 'response_item') => JSON.stringify({ type, payload }) + '\n'

test('the Codex host keeps the pinned Orca model text and uses its MCP tool names', () => {
  assert.equal(systemText(ORCA_CODEX), systemText(ORCA))
  assert.equal(ORCA_CODEX.agent, 'Codex')
  assert.equal(ORCA_CODEX.recordTool, 'mcp__orca-inbox__record')
  assert.equal(ORCA_CODEX.closeTool, 'mcp__orca-inbox__close')
})

test('one complete turn has a stable id, prompt, reply, and byte offset', () => {
  const file = fixture('one')
  const read = readCodexTurn(file, 0)
  assert.deepEqual(read, {
    status: 'complete',
    turnId: 'turn-1',
    exchange: { person: 'What is here?', trigger: null, activity: [], reply: 'A small project.', turn: 1, press: null, screen: '' },
    nextOffset: readFileSync(file).length,
  })
  assert.equal(readCodexTurn(file, read!.nextOffset), null)
})

test('three completed turns catch up from the saved offset after a restart', () => {
  const file = fixture('three')
  const found = []
  for (let offset = 0, read = readCodexTurn(file, offset); read; read = readCodexTurn(file, offset)) {
    found.push(read)
    offset = read.nextOffset
  }
  assert.deepEqual(found.map(read => [read.turnId, read.status, read.exchange.turn, read.exchange.reply]), [
    ['turn-1', 'complete', 1, 'A small project.'],
    ['turn-2', 'complete', 2, 'All tests passed.'],
    ['turn-3', 'complete', 3, 'You are welcome.'],
  ])
  assert.deepEqual(found[1].exchange.activity, ['ran: npm test'])
  assert.equal(found[2].nextOffset, readFileSync(file).length)
})

test('a turn carries when its task started, and none when the row has no time', () => {
  const started = (stamp: object) => JSON.stringify({ ...stamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }) + '\n'
  const read = (stamp: object) => readCodexTurn(Buffer.from(started(stamp) + row({ type: 'task_complete' }, 'event_msg')), 0)
  assert.equal(read({ timestamp: '2026-01-01T00:00:05.000Z' })?.exchange.startedAt, Date.parse('2026-01-01T00:00:05.000Z'))
  assert.equal(read({})?.exchange.startedAt, undefined)
})

test('a newly tracked resume starts at its current turn and skips old history', () => {
  const bytes = readFileSync(fixture('three'))
  const start = codexResumeStart(bytes, 'turn-3')
  assert.equal(start.turn, 2)
  assert.equal(readCodexTurn(bytes, start.offset)?.turnId, 'turn-3')
  assert.equal(codexResumeStart(bytes, 'not-yet-written').offset, bytes.length)
  const first = readCodexTurn(bytes, 0)!
  assert.equal(codexToolTurn(bytes, first.nextOffset, 'turn-2'), 2)
  assert.equal(codexToolTurn(bytes, first.nextOffset, 'turn-3'), null)
})

test('a resumed Codex thread appends to the same rollout after the saved offset', () => {
  const file = join(temporary(), 'rollout.jsonl')
  copyFileSync(fixture('one'), file)
  const first = readCodexTurn(file, 0)!
  appendFileSync(file, row({ type: 'task_started', turn_id: 'turn-2' }, 'event_msg'))
  appendFileSync(file, row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }))
  appendFileSync(file, row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }))
  assert.equal(readCodexTurn(file, first.nextOffset)?.status, 'pending')
  appendFileSync(file, row({ type: 'task_complete', turn_id: 'turn-2' }, 'event_msg'))
  const resumed = readCodexTurn(file, first.nextOffset)
  assert.equal(resumed?.turnId, 'turn-2')
  assert.equal(resumed?.exchange.turn, 2)
  assert.equal(resumed?.exchange.reply, 'Done.')
})

test('a new prompt before task completion leaves the prior turn incomplete', () => {
  const file = join(temporary(), 'rollout.jsonl')
  writeFileSync(file,
    row({ type: 'task_started', turn_id: 'turn-1' }, 'event_msg') +
    row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First.' }] }) +
    row({ type: 'task_started', turn_id: 'turn-2' }, 'event_msg') +
    row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second.' }] }),
  )
  const first = readCodexTurn(file, 0)!
  assert.equal(first.status, 'incomplete')
  assert.equal(first.exchange.reply, '')
  assert.equal(readCodexTurn(file, first.nextOffset)?.turnId, 'turn-2')
})

test('a half-written last line stays pending until its newline arrives', () => {
  const file = fixture('half-written')
  const first = readCodexTurn(file, 0)!
  const pending = readCodexTurn(file, first.nextOffset)
  assert.equal(pending?.status, 'pending')
  assert.equal(pending?.exchange.reply, '')
  assert.equal(pending?.nextOffset, first.nextOffset)
  const complete = join(temporary(), 'rollout.jsonl')
  copyFileSync(file, complete)
  appendFileSync(complete, 'ing."}]}}\n' + row({ type: 'task_complete', turn_id: 'turn-2' }, 'event_msg'))
  assert.equal(readCodexTurn(complete, first.nextOffset)?.exchange.reply, 'Waiting.')
})

test('the copied reader formats a hand-written rollout and counts earlier turns', async () => {
  const read = await readRollout(fixture('three'), '/repo', 'turn-3')
  assert.equal(read?.earlierTurns, 2)
  assert.equal(read?.conversation, [
    'Person: What is here?', 'Agent: A small project.',
    'Person: Run the tests.', 'Agent ran: npm test', 'Agent: All tests passed.',
    'Person: Thanks.', 'Agent: You are welcome.',
  ].join('\n'))
})

test('the copied turn reader finds completed commands and dialog calls', async () => {
  const file = join(temporary(), 'rollout.jsonl')
  writeFileSync(file,
    row({ type: 'task_started', turn_id: 'turn-1' }, 'event_msg') +
    row({ type: 'item_completed', item: { type: 'CommandExecution', command: 'npm test', aggregated_output: 'passed' } }, 'event_msg') +
    row({ type: 'function_call', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [{ title: 'Ship?', options: ['Yes', 'No'] }] }) }),
  )
  const read = await turnIn(file, 'turn-1')
  assert.deepEqual(read.commands, [{ command: 'npm test', output: 'passed' }])
  assert.deepEqual(read.dialogs, [[{ question: 'Ship?', options: ['Yes', 'No'] }]])
})

test('the copied rollout reader skips injected context and reads older shell and patch calls', async () => {
  const file = join(temporary(), 'rollout.jsonl')
  writeFileSync(file,
    row({ type: 'task_started', turn_id: 'turn-1' }, 'event_msg') +
    row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }] }) +
    row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the file.' }] }) +
    row({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['sh', '-lc', 'npm test'] }) }) +
    row({ type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }) }) +
    row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] }) +
    row({ type: 'task_complete', turn_id: 'turn-1' }, 'event_msg'),
  )
  assert.equal((await readRollout(file, '/repo'))?.conversation,
    'Person: Fix the file.\nAgent ran: npm test\nAgent edited /repo/src/a.ts\nAgent: Fixed.')
  assert.equal(await readRollout(null, '/repo'), null)
  assert.equal(await readRollout(join(temporary(), 'missing.jsonl'), '/repo'), null)
})

test('rollout lookup uses the thread id and excludes subagent and exec rollouts', async () => {
  const home = temporary()
  const dir = join(home, 'sessions', '2026', '11', '05')
  mkdirSync(dir, { recursive: true })
  const own = join(dir, 'rollout-2026-11-05-chat-1.jsonl')
  writeFileSync(own, row({ cwd: '/repo' }, 'session_meta'))
  writeFileSync(join(dir, 'rollout-2026-11-05-sub-1.jsonl'), row({ parent_thread_id: 'chat-1' }, 'session_meta'))
  writeFileSync(join(dir, 'rollout-2026-11-05-exec-1.jsonl'), row({ originator: 'codex_exec' }, 'session_meta'))
  writeFileSync(join(dir, 'rollout-2026-11-05-packed.jsonl.zst'), row({ cwd: '/repo' }, 'session_meta'))
  assert.deepEqual(await rolloutFor(home, 'chat-1'), { path: own, cwd: '/repo' })
  assert.equal(await rolloutFor(home, 'sub-1'), null)
  assert.equal(await rolloutFor(home, 'exec-1'), null)
  assert.equal(await rolloutFor(home, 'missing'), null)
  assert.equal(await rolloutFor(home, 'packed'), null)
})
