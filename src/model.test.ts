import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { modelArgs, runCodexModel, runInboxModel, type ModelProcess, type Spawn } from './model'
import { ORCA_CODEX, systemText } from './core/model-text'

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

test('the run carries USER and LOGNAME, which the CLI needs to find its login, when the worker has none', async () => {
  const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME }
  delete process.env.USER
  delete process.env.LOGNAME
  try {
    const s = stub({ stdout: GOOD })
    await runInboxModel('p', { spawn: s.spawn })
    assert.equal(s.calls[0]?.env.USER, userInfo().username)
    assert.equal(s.calls[0]?.env.LOGNAME, userInfo().username)
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
  }
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

function codexStub(script: { answer?: string; code?: number; hang?: boolean; stderr?: string }) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; system: string; auth: string | null }[] = []
  let killed = false
  const spawn: Spawn = (command, args, options) => {
    const proc = new EventEmitter()
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const config = args.find(a => a.startsWith('model_instructions_file=')) ?? ''
    const actualSystem = JSON.parse(config.slice('model_instructions_file='.length)) as string
    const home = options.env.CODEX_HOME ?? ''
    calls.push({ command, args, env: options.env, cwd: options.cwd, system: readFileSync(actualSystem, 'utf8'), auth: existsSync(join(home, 'auth.json')) ? readFileSync(join(home, 'auth.json'), 'utf8') : null })
    const child = {
      stdin: { end(_text: string) {
        if (script.hang) return
        setImmediate(() => {
          if (script.stderr) stderr.emit('data', script.stderr)
          if (script.answer !== undefined) writeFileSync(args[args.indexOf('-o') + 1], script.answer)
          proc.emit('close', script.code ?? 0)
        })
      } },
      stdout, stderr,
      on: (event: string, fn: (...a: any[]) => void) => proc.on(event, fn),
      kill: () => { killed = true; proc.emit('close', null) },
    }
    return child as unknown as ModelProcess
  }
  return { spawn, calls, killed: () => killed }
}

test('Codex exec uses the pane account, isolated instructions, source flags and a parsed answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-codex-account-'))
  writeFileSync(join(home, 'auth.json'), 'hand-written-auth')
  const stub = codexStub({ answer: GOOD })
  const result = await runInboxModel('prompt', { codexHome: home, spawn: stub.spawn })
  assert.equal(result.ok, true)
  const call = stub.calls[0]
  assert.equal(call.command, 'codex')
  assert.equal(call.system, systemText(ORCA_CODEX))
  assert.equal(call.auth, 'hand-written-auth')
  assert.notEqual(call.env.CODEX_HOME, home, 'auth file is linked into a clean model home')
  assert.deepEqual(call.args.slice(0, 10), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '-C', call.cwd, '-m'])
  assert.ok(call.args.includes('model_reasoning_effort="low"'))
  assert.ok(call.args.includes('project_doc_max_bytes=0'))
  assert.ok(call.args.includes('cli_auth_credentials_store="file"'))
  assert.ok(call.args.includes('--disable'))
  assert.equal(call.args.at(-1), 'prompt')
})

test('Codex exec keeps a keyring account home, reports bad answers and failed runs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-codex-keyring-'))
  const bad = codexStub({ answer: 'hello' })
  const unparsed = await runCodexModel('prompt', home, { spawn: bad.spawn })
  assert.ok(!unparsed.ok)
  assert.equal(unparsed.reason, 'unparsed')
  assert.equal(bad.calls[0].env.CODEX_HOME, home)
  const failed = await runCodexModel('prompt', home, { spawn: codexStub({ code: 1, stderr: 'API failed' }).spawn })
  assert.ok(!failed.ok)
  assert.equal(failed.reason, 'failed')
  assert.equal(failed.detail, 'API failed')
})

test('Codex exec kills a slow run at its timeout', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-codex-timeout-'))
  const stub = codexStub({ hang: true })
  const result = await runCodexModel('prompt', home, { spawn: stub.spawn, timeoutMs: 10 })
  assert.ok(!result.ok)
  assert.equal(result.reason, 'timeout')
  assert.equal(stub.killed(), true)
})

test('Codex exec waits for the pane account before spawning', async () => {
  const stub = codexStub({ answer: GOOD })
  const result = await runCodexModel('prompt', '', { spawn: stub.spawn })
  assert.ok(!result.ok)
  assert.equal(result.reason, 'unavailable')
  assert.equal(stub.calls.length, 0)
})
