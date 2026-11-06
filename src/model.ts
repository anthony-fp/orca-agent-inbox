// Runs the inbox model, as the mod's askLedgerModel does (inbox repo hooks/claude-host.ts:429-436):
// Sonnet, low effort, 1600 output tokens at most, 45 s. Orca gives a plugin no model call, so this
// runs `claude -p`. One run per terminal at a time is the turn tracker's job, not this file's.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { parseReply, type Update } from './core/ledger'
import { ORCA, ORCA_CODEX, systemText } from './core/model-text'

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
  | { ok: false; reason: 'timeout' | 'failed' | 'unparsed' | 'unavailable'; detail: string; ms: number }

export type ModelOptions = {
  timeoutMs?: number
  /** The exchange's reply, then its activity, joined by newlines: `parseReply` checks HELP values against it. */
  source?: string | null
  system?: string
  spawn?: Spawn
  /** The pane's Codex account. Its auth file is linked into an isolated model home when present. */
  codexHome?: string
}

export function runInboxModel(prompt: string, opts: ModelOptions = {}): Promise<ModelResult> {
  if (opts.codexHome !== undefined) return runCodexModel(prompt, opts.codexHome, opts)
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

/** The model and feature flags used by the inbox's Codex runner. */
export const CODEX_MODEL = 'gpt-6.1-sol'
const CODEX_TIMEOUT_MS = 120_000
const CODEX_OFF = [
  'shell_tool', 'unified_exec', 'code_mode_host', 'apps', 'plugins', 'memories', 'multi_agent',
  'image_generation', 'browser_use', 'computer_use', 'tool_suggest', 'skill_search',
  'view_image', 'goals', 'sleep_tool', 'personality',
]

export function codexModelArgs(work: string, system: string, output: string, isolatedHome: boolean, off = CODEX_OFF): string[] {
  return [
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '-s', 'read-only', '-C', work, '-m', CODEX_MODEL,
    '-c', 'model_reasoning_effort="low"',
    '-c', `model_instructions_file=${JSON.stringify(system)}`,
    '-c', 'project_doc_max_bytes=0',
    ...(isolatedHome ? ['-c', 'cli_auth_credentials_store="file"'] : []),
    ...off.flatMap(feature => ['--disable', feature]),
    '-o', output,
  ]
}

/** Use the pane's sign-in without loading its home AGENTS.md into the inbox model. */
async function isolatedCodexHome(root: string, personHome: string): Promise<string | null> {
  const auth = join(personHome, 'auth.json')
  if (!(await access(auth).then(() => true, () => false))) return null
  const home = join(root, 'home')
  await mkdir(home)
  await symlink(auth, join(home, 'auth.json'))
  return home
}

/** Codex may replace the auth link while refreshing; keep the newer sign-in before removing the temporary home. */
async function keepRefreshedAuth(home: string | null, personHome: string): Promise<void> {
  if (!home) return
  const saved = join(home, 'auth.json')
  const info = await lstat(saved).catch(() => null)
  if (!info?.isFile()) return
  const auth = join(personHome, 'auth.json')
  const original = await stat(auth).catch(() => null)
  if (original && info.mtimeMs > original.mtimeMs) await copyFile(saved, auth)
}

/** A single codex exec attempt, with the final answer read from -o rather than progress on stdout. */
async function codexAttempt(args: string[], home: string, work: string, timeoutMs: number, spawn: Spawn): Promise<{ code: number | null; stderr: string; stdout: string; timedOut: boolean; error?: string }> {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (code: number | null, timedOut = false, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stderr: err, stdout: out, timedOut, error })
    }
    const user = userInfo().username
    const child = spawn('codex', args, { cwd: work, env: { ...process.env, USER: process.env.USER || user, LOGNAME: process.env.LOGNAME || user, CODEX_HOME: home } })
    const timer = setTimeout(() => {
      finish(null, true)
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', chunk => (out += chunk))
    child.stderr?.on('data', chunk => (err += chunk))
    child.on('error', e => finish(null, false, e.message))
    child.on('close', code => finish(code))
    child.stdin?.end('')
  })
}

export async function runCodexModel(prompt: string, codexHome: string, opts: ModelOptions = {}): Promise<ModelResult> {
  if (!codexHome) return { ok: false, reason: 'unavailable', detail: 'Codex account home is not known yet', ms: 0 }
  const started = Date.now()
  const root = await mkdtemp(join(tmpdir(), 'orca-inbox-codex-'))
  const work = join(root, 'work')
  const system = join(root, 'inbox-system.md')
  const output = join(root, `reply-${randomUUID()}.txt`)
  let isolated: string | null = null
  try {
    await mkdir(work)
    await writeFile(system, opts.system ?? systemText(ORCA_CODEX))
    isolated = await isolatedCodexHome(root, codexHome).catch(() => null)
    let off = [...CODEX_OFF]
    for (let tries = 0; tries <= CODEX_OFF.length; tries++) {
      await rm(output, { force: true })
      const args = [...codexModelArgs(work, system, output, isolated !== null, off), prompt]
      const result = await codexAttempt(args, isolated ?? codexHome, work, opts.timeoutMs ?? CODEX_TIMEOUT_MS, opts.spawn ?? nodeSpawn as Spawn)
      if (result.timedOut) return { ok: false, reason: 'timeout', detail: `no answer in ${opts.timeoutMs ?? CODEX_TIMEOUT_MS} ms`, ms: Date.now() - started }
      const { stderr } = result
      const unknown = stderr.match(/Unknown feature flag: (\S+)/)?.[1]
      if (result.code !== 0 && unknown && off.includes(unknown)) {
        off = off.filter(feature => feature !== unknown)
        continue
      }
      if (result.code !== 0) return { ok: false, reason: 'failed', detail: result.error ?? ((stderr || result.stdout).trim() || `codex exited ${result.code}`), ms: Date.now() - started }
      const text = await readFile(output, 'utf8').catch(() => null)
      if (text === null) return { ok: false, reason: 'failed', detail: 'Codex wrote no answer', ms: Date.now() - started }
      const update = parseReply(text, opts.source ?? null)
      return update
        ? { ok: true, update, text, ms: Date.now() - started }
        : { ok: false, reason: 'unparsed', detail: text.trim(), ms: Date.now() - started }
    }
    return { ok: false, reason: 'failed', detail: 'Codex rejected model feature flags', ms: Date.now() - started }
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e), ms: Date.now() - started }
  } finally {
    await keepRefreshedAuth(isolated, codexHome).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}
