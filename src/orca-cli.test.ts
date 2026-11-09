import assert from 'node:assert/strict'
import { test } from 'node:test'

import { launchOf, orcaBinary, runOrca, type OrcaEnv, type OrcaExecFile } from './orca-cli'

/** A machine where only `present` exists. */
const machine = (present: string[], over: Partial<OrcaEnv> = {}): OrcaEnv => ({
  platform: 'darwin',
  env: { PATH: '/usr/local/bin:/usr/bin' },
  execPath: '/Volumes/Orca/Orca.app/Contents/MacOS/Orca',
  exists: path => present.includes(path),
  ...over,
})

/** An execFile that answers each run with `answer`, and records the file and args. */
function stub(answer: { error?: Error & { code?: unknown; killed?: boolean }; stdout?: string; stderr?: string }) {
  const calls: { file: string; args: string[]; timeout: number }[] = []
  const execFile: OrcaExecFile = (file, args, options, done) => {
    calls.push({ file, args, timeout: options.timeout })
    setImmediate(() => done(answer.error ?? null, answer.stdout ?? '', answer.stderr ?? ''))
  }
  return { execFile, calls }
}

test('the binary: ORCA_CLI_BIN_DIR, then the running Orca, then the app, then PATH, else the bare name', () => {
  const bin = '/opt/orca-bin/orca'
  const running = '/Volumes/Orca/Orca.app/Contents/Resources/bin/orca'
  const app = '/Applications/Orca.app/Contents/Resources/bin/orca'
  const onPath = '/usr/local/bin/orca'
  const env = { PATH: '/usr/local/bin:/usr/bin', ORCA_CLI_BIN_DIR: '/opt/orca-bin' }
  assert.equal(orcaBinary(machine([bin, running, app, onPath], { env })), bin)
  assert.equal(orcaBinary(machine([running, app, onPath], { env })), running)
  assert.equal(orcaBinary(machine([app, onPath], { env })), app)
  assert.equal(orcaBinary(machine([onPath], { env })), onPath)
  assert.equal(orcaBinary(machine([], { env })), 'orca')
})

test('a run adds --json, waits 60 s, and gives the result of {ok:true}', async () => {
  const s = stub({ stdout: JSON.stringify({ id: 'x', ok: true, result: { worktree: { displayName: 'fix-it' } } }) })
  const out = await runOrca(['worktree', 'create', '--name', 'fix-it'], { execFile: s.execFile, at: machine([]) })
  assert.deepEqual(out, { kind: 'ok', result: { worktree: { displayName: 'fix-it' } } })
  assert.deepEqual(s.calls, [{ file: 'orca', args: ['worktree', 'create', '--name', 'fix-it', '--json'], timeout: 60_000 }])
})

test('{ok:false} with no launch in it is a clean error with its message', async () => {
  const error = Object.assign(new Error('Command failed'), { code: 1 })
  const stdout = JSON.stringify({ id: 'x', ok: false, error: { code: 'repo_not_found', message: 'No repo at path' } })
  const out = await runOrca(['worktree', 'create'], { execFile: stub({ error, stdout }).execFile, at: machine([]) })
  assert.deepEqual(out, { kind: 'error', error: 'No repo at path' })
})

test('{ok:false} that says the launch outcome is unknown is uncertain, with its operation id', async () => {
  const error = Object.assign(new Error('Command failed'), { code: 1 })
  const stdout = JSON.stringify({
    ok: false,
    error: { code: 'agent_session_operation_unknown', message: 'Orca could not confirm the launch outcome', data: { launchOutcome: 'unknown', operationId: 'op-1' } },
  })
  const out = await runOrca(['worktree', 'create'], { execFile: stub({ error, stdout }).execFile, at: machine([]) })
  assert.deepEqual(out, { kind: 'uncertain', error: 'Orca could not confirm the launch outcome', operationId: 'op-1' })
})

test('a timeout is uncertain, not an error: the CLI may have made the worktree', async () => {
  const error = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
  const out = await runOrca(['worktree', 'create'], { execFile: stub({ error }).execFile, at: machine([]) })
  assert.deepEqual(out, { kind: 'uncertain', error: 'no answer in 60 s', operationId: null })
})

test('a lost reply (text that is not JSON) is uncertain; a missing binary is a clean error', async () => {
  const lost = await runOrca(['worktree', 'create'], { execFile: stub({ stdout: 'Segmentation fault' }).execFile, at: machine([]) })
  assert.equal(lost.kind, 'uncertain')
  const error = Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' })
  const missing = await runOrca(['worktree', 'create'], { execFile: stub({ error }).execFile, at: machine([]) })
  assert.deepEqual(missing, { kind: 'error', error: 'The orca CLI was not found' })
})

test('launchOf: started needs the agent handle and the prompt handed over or journaled', () => {
  const result = (prompt: string | undefined, handle: string | undefined = 'term_1') => ({
    worktree: { displayName: 'fix-it', path: '/w/fix-it' },
    launch: { outcome: { kind: 'terminal', handle }, prompt: prompt === undefined ? undefined : { delivery: 'submit', outcome: prompt }, operationId: 'op-1' },
  })
  assert.deepEqual(launchOf(result('handed-to-terminal')), { worktree: 'fix-it', operationId: 'op-1', started: true })
  assert.equal(launchOf(result('journaled')).started, true)
  assert.equal(launchOf(result('not-delivered')).started, false)
  assert.equal(launchOf(result('unconfirmed')).started, false)
  assert.equal(launchOf(result(undefined)).started, false)
  assert.equal(launchOf(result('handed-to-terminal', '')).started, false)
  assert.deepEqual(launchOf({ worktree: { path: '/w/fix-it' } }), { worktree: '/w/fix-it', operationId: null, started: false }, 'an older Orca gives no launch')
  assert.equal(launchOf({}).worktree, null)
})
