// The worker's local socket: the MCP server (bin/mcp-server.mjs) and the prompt hook (bin/prompt-hook.mjs) send it
// one JSON line each and read one JSON line back (spec "The agent's tools", steps 2-4, and "The session plan", step 1).
//
// The worker is the only writer. A tool call is applied at once, through the tracker's `edit`, so it lands in the
// same ordered saves as the model runs, and is stamped with the session's active turn.
import { randomBytes } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import { chmod, lstat, mkdir, rename } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ORCA, ORCA_CODEX, promptNotes } from './core/model-text'
import { recordClose, recordItem } from './core/tools'
import type { SessionState, State } from './state'

/** macOS limits a unix socket path to 104 bytes, the last for the end mark. */
const MAX_PATH = 103

/**
 * The worker's socket, per user, in a 0700 folder. It is not in the plugin's folder, as the spec first said: an
 * installed plugin's folder may be read-only, and its path may pass the length limit. The temp folder is per user
 * on macOS; the uid in the name keeps a shared /tmp apart too.
 */
export function socketPath(): string {
  const name = `orca-agent-inbox-${process.getuid?.() ?? userInfo().uid}`
  const path = join(tmpdir(), name, 'worker.sock')
  return Buffer.byteLength(path) <= MAX_PATH ? path : join('/tmp', name, 'worker.sock')
}

/** The two scripts the launch hook names, in the plugin's own folder: Orca imports the worker from its file there. */
export function binPaths(): { mcpServer: string; promptHook: string } {
  const root = fileURLToPath(new URL('..', import.meta.url))
  return { mcpServer: join(root, 'bin', 'mcp-server.mjs'), promptHook: join(root, 'bin', 'prompt-hook.mjs') }
}

export type Request =
  | { type: 'prompt-start'; sessionId: string; cwd?: string; terminalId?: string }
  | { type: 'inbox-text'; sessionId: string; prompt?: string; cwd?: string }
  | { type: 'record' | 'close'; sessionId: string; args: Record<string, unknown> }
  | { type: 'codex-turn'; payload: { paneKey: string; codexHome: string; threadId: string; turnId: string; type: string } }

/** `text` is the answer the client prints or returns; `error` means it gives up as on a timeout. */
export type Answer = { text: string } | { error: string }

export type AnswerDeps = {
  state(): State
  edit(sessionId: string, change: (s: SessionState) => SessionState): Promise<void>
  now(): number
  /** The plan note for a session (planNote), read from its plan file now; null when its folder is not known. */
  planNote(sessionId: string): Promise<string | null>
  /** Maps the prompt hook's terminal to a session that has none yet. */
  bind?(terminalId: string, sessionId: string, paneKey?: string): Promise<void>
  /** Saves a main Codex pane before its prompt or tool call receives an answer. */
  bindCodex?(paneKey: string, threadId: string, codexHome: string, source: 'prompt' | 'tool' | 'notify', turnId?: string): Promise<void>
  /** The notify id is saved after main-thread verification, before the socket replies. */
  notifyCodex?(paneKey: string, threadId: string, turnId: string): Promise<void>
}

/** Orca's terminal handle, `term_` and an id, as Orca sets ORCA_TERMINAL_HANDLE. Any other value is ignored. */
const HANDLE = /^term_[A-Za-z0-9-]{1,128}$/

/** The turn a tool call made now belongs to. The transcript's count can catch up with the prompt-starts. */
export function activeTurn(s: SessionState): number {
  return Math.max(s.activeTurn, s.ledger.turn)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TYPES = ['prompt-start', 'inbox-text', 'record', 'close', 'codex-turn']

/** Answers one request. */
export function createAnswerer(deps: AnswerDeps): (request: unknown) => Promise<Answer> {
  /** Runs `change` on the session and saves it; null when the session is gone. */
  async function apply<T>(sessionId: string, change: (s: SessionState) => { session: SessionState; out: T }): Promise<T | null> {
    let out: T | null = null
    await deps.edit(sessionId, s => {
      const r = change(s)
      out = r.out
      return r.session
    })
    return out
  }

  return async request => {
    if (!isObject(request) || !TYPES.includes(request.type as string))
      return { error: 'bad request' }
    const paneKey = typeof request.paneKey === 'string' ? request.paneKey : ''
    const codexHome = typeof request.codexHome === 'string' ? request.codexHome : ''
    if (request.type === 'codex-turn') {
      const payload = isObject(request.payload) ? request.payload : {}
      if (typeof payload.paneKey !== 'string' || !payload.paneKey || typeof payload.codexHome !== 'string' || !payload.codexHome || typeof payload.threadId !== 'string' || !payload.threadId)
        return { error: 'bad request' }
      await deps.bindCodex?.(payload.paneKey, payload.threadId, payload.codexHome, 'notify', typeof payload.turnId === 'string' ? payload.turnId : undefined)
      const state = deps.state()
      if (state.version !== 1 && state.panes[payload.paneKey]?.threadId === payload.threadId)
        await deps.notifyCodex?.(payload.paneKey, payload.threadId, typeof payload.turnId === 'string' ? payload.turnId : '')
      return { text: '' }
    }
    const current = deps.state()
    const savedThread = paneKey && current.version !== 1 ? current.panes[paneKey]?.threadId : undefined
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : savedThread
    if (!sessionId) return { error: 'bad request' }
    if (paneKey && typeof request.sessionId === 'string')
      await deps.bindCodex?.(paneKey, sessionId, codexHome, request.type === 'prompt-start' ? 'prompt' : 'tool', typeof request.codexTurnId === 'string' ? request.codexTurnId : undefined)
    const s0 = deps.state().sessions[sessionId]
    if (!s0) return { error: 'unknown session' }
    const host = paneKey ? ORCA_CODEX : ORCA
    // The prompt hook's `cwd` gives the session's folder before its transcript exists, at the first prompt.
    const cwd = typeof request.cwd === 'string' && request.cwd !== '' ? request.cwd : null
    const withCwd = (s: SessionState): SessionState => (s.cwd || !cwd ? s : { ...s, cwd })

    if (request.type === 'prompt-start') {
      // A launch Orca gave no terminal id is bound to the terminal its prompt hook runs in.
      if (typeof request.terminalId === 'string' && HANDLE.test(request.terminalId)) await deps.bind?.(request.terminalId, sessionId, paneKey || undefined)
      // Raised and saved before the answer, so the agent's first call in this turn carries the new turn.
      const started = await apply(sessionId, s => ({ session: { ...withCwd(s), activeTurn: activeTurn(s) + 1 }, out: true }))
      return started === null ? { error: 'unknown session' } : { text: '' }
    }

    if (request.type === 'record' || request.type === 'close') {
      const run = request.type === 'record' ? recordItem : recordClose
      const args = isObject(request.args) ? request.args : {}
      const result = await apply(sessionId, s => {
        // The tool stamps with ledger.turn, so it reads the active turn; the ledger keeps the transcript's count.
        const r = run(host, { ...s.ledger, turn: activeTurn(s) }, args, deps.now())
        return { session: { ...s, ledger: { ...r.ledger, turn: s.ledger.turn } }, out: r.result }
      })
      return result === null ? { error: 'unknown session' } : { text: result }
    }

    // inbox-text: what the inbox skill adds beside a prompt (inbox repo hooks/register.tsx, prompt.submit): the
    // notes promptNotes gives, as recordPrompt makes them (hooks/session.ts), then the plan note. The skill adds each as
    // its own context entry; one hook's stdout holds them all, so a blank line parts them.
    if (cwd && !s0.cwd) await deps.edit(sessionId, withCwd)
    const plan = await deps.planNote(sessionId)
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    if (paneKey && prompt !== '' && Object.entries(deps.state().sessions).some(([id, s]) =>
      id !== sessionId && s.agent === 'codex' && Object.values(s.presses).some(l => l.paneKey === paneKey && l.state === 'sending' && deps.now() - l.at < 10_000 && l.text === prompt)))
      return { error: 'press sent for a different Codex thread' }
    const notes = await apply(sessionId, s => {
      // A prompt the panel typed for a press is no answer to number: the skill passes isPress for its own sends.
      const isPress = prompt !== '' && Object.values(s.presses).some(l => l.state === 'sending' && l.text === prompt)
      const r = promptNotes(host, { ...s.ledger, turn: activeTurn(s) }, { text: prompt, isPress, isOpen: false }, s.told)
      return { session: { ...s, told: r.told }, out: r.notes }
    })
    if (notes === null) return { error: 'unknown session' }
    return { text: [...notes, ...(plan === null ? [] : [plan])].join('\n\n') }
  }
}

/** A request line longer than this is dropped. */
const MAX_REQUEST = 1 << 20

/**
 * Listens on `path`: a 0600 socket in a 0700 folder the user owns. The socket is made under a name of its own, then
 * renamed onto `path`, which replaces a file an earlier worker left. Node removes the name a socket was made under
 * when its server closes, so a closing server removes `path` only while `path` is still its own socket: an old worker
 * that closes after a new one started leaves the new one's file.
 */
export async function listen(path: string, answer: (request: unknown) => Promise<Answer>, log?: (m: string) => void): Promise<Server> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error(`${dir} is not a folder this user owns`)
  await chmod(dir, 0o700)
  const own = join(dir, `${randomBytes(3).toString('hex')}.s`)

  const server = createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', e => log?.(`socket: ${e.message}`))
    conn.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_REQUEST) return void conn.destroy()
      const end = buf.indexOf('\n')
      if (end === -1) return
      const line = buf.slice(0, end)
      buf = ''
      conn.pause()
      let request: unknown = null
      try {
        request = JSON.parse(line)
      } catch {
        // answered as a bad request
      }
      answer(request)
        .catch((e: unknown): Answer => {
          log?.(`socket: ${e instanceof Error ? e.message : String(e)}`)
          return { error: 'failed' }
        })
        .then(a => conn.end(`${JSON.stringify(a)}\n`))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(own, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(own, 0o600)
  const { ino } = await lstat(own)
  await rename(own, path)
  server.on('close', () => {
    try {
      if (lstatSync(path).ino === ino) unlinkSync(path)
    } catch {
      // gone already
    }
  })
  server.on('error', e => log?.(`socket: ${e.message}`))
  return server
}
