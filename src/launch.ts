// Launch tagging (spec "How it works", step 1, and "Codex (version 2)", step 1). A pure function:
// the agent.launch.before hook calls it and passes its command on. It adds `--session-id <uuid>` to
// a new Claude Code session or `-c` inbox flags to an interactive Codex launch.
// It never changes any other part of any command.

import { dirname, join } from 'node:path'

import { guidanceText, ORCA, ORCA_CODEX } from './core/model-text'

export type LaunchSession = { id: string; kind: 'new' | 'resume' } | { kind: 'codex'; id?: undefined }

export interface TaggedLaunch {
  command: string
  session: LaunchSession | null
  /** True when the launch got the inbox tools: the MCP server, the guidance and the prompt hook. */
  tools: boolean
}

/** Where the tool scripts and the worker's socket are. */
export interface LaunchTools {
  socketPath: string
  mcpServer: string
  promptHook: string
}

/**
 * Flags the person already set that the added tool flags could clash with. A launch with one of
 * them is still tagged but gets no tools. The `-file` forms set the same prompts.
 */
const TOOL_FLAGS = new Set([
  '--mcp-config',
  '--strict-mcp-config',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt',
  '--system-prompt-file',
  '--settings',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

interface Token {
  text: string
  end: number
}

/**
 * Splits a simple command line into words with POSIX quoting rules. Returns null for anything
 * this parser does not fully understand: an open quote, or an operator, redirect, glob, expansion
 * or substitution outside single quotes. A null leaves the launch unchanged and untracked.
 */
export function tokenize(line: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
    if (i >= line.length) break
    let text = ''
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') {
      const c = line[i]
      if (c === "'") {
        const close = line.indexOf("'", i + 1)
        if (close < 0) return null
        text += line.slice(i + 1, close)
        i = close + 1
      } else if (c === '"') {
        i++
        for (;;) {
          if (i >= line.length) return null
          const d = line[i]
          if (d === '"') break
          if (d === '$' || d === '`') return null
          if (d === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])) {
            text += line[i + 1]
            i += 2
          } else {
            text += d
            i++
          }
        }
        i++
      } else if (c === '\\') {
        if (i + 1 >= line.length) return null
        text += line[i + 1]
        i += 2
      } else if (';&|<>()$`\n\r*?[]{}~#'.includes(c)) {
        return null
      } else {
        text += c
        i++
      }
    }
    tokens.push({ text, end: i })
  }
  return tokens
}

/** Quotes one word for a POSIX shell: single quotes, with each ' written as '\''. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The flags that give session `id` the inbox tools, each value quoted. `--mcp-config` takes several
 * values, so a flag must follow it: it never comes last.
 */
function toolFlags(id: string, t: LaunchTools): string {
  const mcp = { mcpServers: { 'orca-inbox': { command: 'node', args: [t.mcpServer, '--socket', t.socketPath, '--session', id] } } }
  const hook = ['node', t.promptHook, '--socket', t.socketPath, '--session', id].map(shellQuote).join(' ')
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook }] }] } }
  return [
    '--mcp-config', shellQuote(JSON.stringify(mcp)),
    '--append-system-prompt', shellQuote(guidanceText(ORCA)),
    '--settings', shellQuote(JSON.stringify(settings)),
  ].join(' ')
}

/** Each Codex -c value is TOML within one shell word. The prompt hook has no per-launch input. */
function codexFlags(t: LaunchTools): string {
  const notify = join(dirname(t.mcpServer), 'codex-notify.mjs')
  const hook = ['node', t.promptHook, '--socket', t.socketPath].map(shellQuote).join(' ')
  const values = [
    `notify=${JSON.stringify(['node', notify, t.socketPath])}`,
    `mcp_servers.orca-inbox.command=${JSON.stringify('node')}`,
    `mcp_servers.orca-inbox.args=${JSON.stringify([t.mcpServer, '--socket', t.socketPath])}`,
    `mcp_servers.orca-inbox.env_vars=${JSON.stringify(['ORCA_PANE_KEY'])}`,
    `mcp_servers.orca-inbox.default_tools_approval_mode=${JSON.stringify('approve')}`,
    `developer_instructions=${JSON.stringify(guidanceText(ORCA_CODEX))}`,
    `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(hook)}}]}]`,
  ]
  return values.map(value => `-c ${shellQuote(value)}`).join(' ')
}

function isClaude(word: string): boolean {
  return word.slice(word.lastIndexOf('/') + 1) === 'claude'
}

function isCodex(word: string): boolean {
  return word.slice(word.lastIndexOf('/') + 1) === 'codex'
}

/** Codex config that would be overwritten by the plugin's flags. */
function codexClash(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break
    const value = args[i] === '-c' || args[i] === '--config' ? args[++i] :
      args[i].startsWith('--config=') ? args[i].slice('--config='.length) :
      args[i].startsWith('-c=') ? args[i].slice(3) : null
    if (value === undefined) return true
    if (value === null) continue
    const key = value.split('=', 1)[0]?.trim()
    if (key === 'notify' || key === 'developer_instructions' || key === 'mcp_servers.orca-inbox' || key?.startsWith('mcp_servers.orca-inbox.')) return true
  }
  return false
}

/** Splits `--flag=value` into its flag and value. */
function splitInline(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  return arg.startsWith('--') && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined]
}

/**
 * Gives a Claude Code launch a known session id.
 * - New session: inserts ` --session-id <uuid>` right after the program word, so a trailing
 *   prompt argument stays last and still works. A launch that already sets `--session-id` keeps it.
 * - `--resume <uuid>` with no `--fork-session`: keeps that uuid.
 * - Every other Claude resume form, other agents, and commands this cannot parse: unchanged, null.
 * - With `tools`, a tracked launch also gets the flags from `toolFlags`, right after the program
 *   word, unless it already has a flag in `TOOL_FLAGS`.
 * A Codex launch gets stable `-c` flags unless it is `exec` or sets a conflicting config value.
 */
export function tagLaunch(
  agent: string,
  command: string,
  newId: () => string = () => crypto.randomUUID(),
  tools?: LaunchTools,
): TaggedLaunch {
  const untracked: TaggedLaunch = { command, session: null, tools: false }
  if (agent !== 'claude' && agent !== 'codex') return untracked
  const tokens = tokenize(command)
  if (!tokens) return untracked

  let p = 0
  while (p < tokens.length && ENV_ASSIGNMENT.test(tokens[p].text)) p++
  if (p >= tokens.length) return untracked
  if (agent === 'codex') {
    if (!isCodex(tokens[p].text) || !tools) return untracked
    const args = tokens.slice(p + 1).map(t => t.text)
    const promptAt = args.indexOf('--')
    const beforePrompt = promptAt < 0 ? args : args.slice(0, promptAt)
    if (beforePrompt.includes('exec') || codexClash(args)) return untracked
    const at = tokens[p].end
    return { command: `${command.slice(0, at)} ${codexFlags(tools)}${command.slice(at)}`, session: { kind: 'codex' }, tools: true }
  }
  if (!isClaude(tokens[p].text)) return untracked

  let sessionId: string | null | undefined // undefined: absent; null: present but not a uuid
  let resume: string | null | undefined // undefined: absent; null: no value or not a uuid
  let continued = false
  let fork = false
  let clash = false
  const args = tokens.slice(p + 1).map((t) => t.text)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break
    const [flag, inline] = splitInline(args[i])
    if (flag === '--session-id') {
      const value = inline ?? args[++i]
      sessionId = value !== undefined && UUID.test(value) ? value : null
    } else if (flag === '--resume' || flag === '-r') {
      // The value is optional: it is the next word, unless that word is another flag.
      const next = args[i + 1]
      const value = inline ?? (next !== undefined && !next.startsWith('-') ? args[++i] : undefined)
      resume = value !== undefined && UUID.test(value) ? value : null
    } else if (flag === '--continue' || flag === '-c') {
      continued = true
    } else if (flag === '--fork-session') {
      fork = true
    } else if (TOOL_FLAGS.has(flag)) {
      clash = true
    }
  }

  let session: LaunchSession
  let added = ''
  if (resume !== undefined || continued || fork) {
    if (typeof resume !== 'string' || continued || fork || sessionId !== undefined) return untracked
    session = { id: resume, kind: 'resume' }
  } else if (sessionId === null) {
    return untracked
  } else if (typeof sessionId === 'string') {
    session = { id: sessionId, kind: 'new' }
  } else {
    session = { id: newId(), kind: 'new' }
    added = ` --session-id ${session.id}`
  }

  const withTools = tools !== undefined && !clash
  if (withTools) added += ` ${toolFlags(session.id, tools)}`
  const at = tokens[p].end
  return { command: `${command.slice(0, at)}${added}${command.slice(at)}`, session, tools: withTools }
}
