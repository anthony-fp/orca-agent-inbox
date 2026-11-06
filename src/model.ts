// Runs the inbox model, as the mod's askLedgerModel does (inbox repo hooks/claude-host.ts:429-436):
// Sonnet, low effort, 1600 output tokens at most, 45 s. Orca gives a plugin no model call, so this
// runs `claude -p`. One run per terminal at a time is the turn tracker's job, not this file's.
import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir, userInfo } from 'node:os'

import { parseReply, type Update } from './core/ledger'
import { ORCA, systemText } from './core/model-text'

/** The CLI has no flag for an output cap, so the env var sets it. Over the cap, the run fails. */
export const MAX_OUTPUT_TOKENS = '1600'

export function modelArgs(system: string): string[] {
  return [
    '-p',
    '--model', 'sonnet',
    '--effort', 'low',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--tools', '',
    '--system-prompt', system,
  ]
}

/** The part of a child process the runner uses, so a test can stub it. */
export type ModelProcess = {
  stdin: { end(text: string): void } | null
  stdout: { on(event: 'data', fn: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', fn: (chunk: Buffer | string) => void): void } | null
  on(event: 'close', fn: (code: number | null) => void): void
  on(event: 'error', fn: (error: Error) => void): void
  kill(): void
}

export type Spawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ModelProcess

export type ModelResult =
  | { ok: true; update: Update; text: string; ms: number }
  | { ok: false; reason: 'timeout' | 'failed' | 'unparsed'; detail: string; ms: number }

export type ModelOptions = {
  timeoutMs?: number
  /** The exchange's reply, then its activity, joined by newlines: `parseReply` checks HELP values against it. */
  source?: string | null
  system?: string
  spawn?: Spawn
}

export function runInboxModel(prompt: string, opts: ModelOptions = {}): Promise<ModelResult> {
  const { timeoutMs = 45_000, source = null, system = systemText(ORCA), spawn = nodeSpawn as Spawn } = opts
  const started = Date.now()

  return new Promise(resolve => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (r: ModelResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const fail = (reason: 'timeout' | 'failed' | 'unparsed', detail: string) =>
      finish({ ok: false, reason, detail, ms: Date.now() - started })

    // The cwd is a temp folder so the run reads no project's files.
    // Orca starts the worker with no USER or LOGNAME, and without USER the CLI cannot find its login in the macOS keychain.
    const user = userInfo().username
    const child = spawn('claude', modelArgs(system), {
      cwd: tmpdir(),
      env: {
        ...process.env,
        USER: process.env.USER || user,
        LOGNAME: process.env.LOGNAME || user,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
      },
    })
    const timer = setTimeout(() => {
      fail('timeout', `no answer in ${timeoutMs} ms`)
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', chunk => (out += chunk))
    child.stderr?.on('data', chunk => (err += chunk))
    child.on('error', e => fail('failed', e.message))
    child.on('close', code => {
      if (code !== 0) return fail('failed', (err || out).trim() || `claude exited ${code}`)
      const update = parseReply(out, source)
      if (!update) return fail('unparsed', out.trim())
      finish({ ok: true, update, text: out, ms: Date.now() - started })
    })
    child.stdin?.end(prompt)
  })
}
