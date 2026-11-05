// Launch tagging (spec "How it works", step 1). A pure function: the agent.launch.before hook
// calls it and passes its command on. It adds `--session-id <uuid>` to a new Claude Code session
// and never changes any other part of any command.

export interface LaunchSession {
  id: string
  kind: 'new' | 'resume'
}

export interface TaggedLaunch {
  command: string
  session: LaunchSession | null
}

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
function tokenize(line: string): Token[] | null {
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

function isClaude(word: string): boolean {
  return word.slice(word.lastIndexOf('/') + 1) === 'claude'
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
 * - Every other resume form, any other agent, and any command this cannot parse: unchanged, null.
 */
export function tagLaunch(
  agent: string,
  command: string,
  newId: () => string = () => crypto.randomUUID(),
): TaggedLaunch {
  const untracked: TaggedLaunch = { command, session: null }
  if (agent !== 'claude') return untracked
  const tokens = tokenize(command)
  if (!tokens) return untracked

  let p = 0
  while (p < tokens.length && ENV_ASSIGNMENT.test(tokens[p].text)) p++
  if (p >= tokens.length || !isClaude(tokens[p].text)) return untracked

  let sessionId: string | null | undefined // undefined: absent; null: present but not a uuid
  let resume: string | null | undefined // undefined: absent; null: no value or not a uuid
  let continued = false
  let fork = false
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
    }
  }

  if (resume !== undefined || continued || fork) {
    if (typeof resume === 'string' && !continued && !fork && sessionId === undefined) {
      return { command, session: { id: resume, kind: 'resume' } }
    }
    return untracked
  }
  if (sessionId === null) return untracked
  if (typeof sessionId === 'string') return { command, session: { id: sessionId, kind: 'new' } }

  const id = newId()
  const at = tokens[p].end
  return { command: `${command.slice(0, at)} --session-id ${id}${command.slice(at)}`, session: { id, kind: 'new' } }
}
