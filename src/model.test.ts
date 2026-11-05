import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { modelArgs, runInboxModel, type ModelProcess, type Spawn } from './model'

type Script = { stdout?: string; code?: number; hang?: boolean }

/** A stand-in for `claude -p` that answers with `stdout` and exits with `code`, or never exits. */
function stub(script: Script) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; stdin: string }[] = []
  let killed = false
  const spawn: Spawn = (_command, args, { env }) => {
    const proc = new EventEmitter()
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const call = { args, env, stdin: '' }
    calls.push(call)
    const child = {
      stdin: {
        end(text: string) {
          call.stdin = text
          if (script.hang) return
          setImmediate(() => {
            if (script.stdout) stdout.emit('data', script.stdout)
            proc.emit('close', script.code ?? 0)
          })
        },
      },
      stdout,
      stderr,
      on: (event: string, fn: (...a: any[]) => void) => proc.on(event, fn),
      kill: () => {
        killed = true
        proc.emit('close', null)
      },
    }
    return child as unknown as ModelProcess
  }
  return { spawn, calls, killed: () => killed }
}

const GOOD = [
  'GOAL: Add a dark theme',
  'DONE: -',
  'NOW: Waits on the theme choice',
  'NEW: decide | 1 | Which accent color should the dark theme use? | Blue / Green | Blue',
].join('\n')

test('a good answer parses into an update', async () => {
  const s = stub({ stdout: GOOD })
  const r = await runInboxModel('<card>\n</card>', { spawn: s.spawn, system: 'SYSTEM' })
  assert.equal(r.ok, true)
  assert.ok(r.ok)
  assert.equal(r.update.card.goal, 'Add a dark theme')
  assert.equal(r.update.added.length, 1)
  assert.equal(r.update.added[0]?.kind, 'question')
  assert.deepEqual(r.update.added[0]?.options, ['Blue', 'Green'])
  assert.equal(s.calls[0]?.stdin, '<card>\n</card>')
  assert.deepEqual(s.calls[0]?.args, modelArgs('SYSTEM'))
  assert.equal(s.calls[0]?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '1600')
})

test('an answer with no known key is unparsed', async () => {
  const s = stub({ stdout: 'Sure! Here is the ledger you asked for.' })
  const r = await runInboxModel('p', { spawn: s.spawn })
  assert.equal(r.ok, false)
  assert.ok(!r.ok)
  assert.equal(r.reason, 'unparsed')
})

test('a nonzero exit is a failure', async () => {
  const s = stub({ stdout: 'API Error: overloaded', code: 1 })
  const r = await runInboxModel('p', { spawn: s.spawn })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'failed')
  assert.equal(r.detail, 'API Error: overloaded')
})

test('a run past the timeout is killed', async () => {
  const s = stub({ hang: true })
  const r = await runInboxModel('p', { spawn: s.spawn, timeoutMs: 20 })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'timeout')
  assert.equal(s.killed(), true)
})
