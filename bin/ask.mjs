// What bin/mcp-server.mjs and bin/prompt-hook.mjs share: their arguments, and one request to the worker's socket.
// Plain Node with no dependencies; it keeps no state.
import { connect } from 'node:net'

/** The worker answers within this, or the caller gives up (spec "The agent's tools", step 2). */
export const TIMEOUT_MS = 5000

/** `--socket <path> --session <id>`, and `--timeout <ms>` for tests. */
export function readArgs(argv) {
  const value = name => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const timeout = Number(value('--timeout'))
  return { socket: value('--socket') ?? '', session: value('--session') ?? '', timeout: timeout > 0 ? timeout : TIMEOUT_MS }
}

/** Sends one request line and reads one answer line: the parsed answer, or null on an error or after `timeoutMs`. */
export function ask(socket, request, timeoutMs) {
  return new Promise(resolve => {
    let buf = ''
    const conn = connect(socket)
    const timer = setTimeout(() => finish(null), timeoutMs)
    function finish(answer) {
      clearTimeout(timer)
      conn.destroy()
      resolve(answer)
    }
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(`${JSON.stringify(request)}\n`))
    conn.on('data', chunk => {
      buf += chunk
      const end = buf.indexOf('\n')
      if (end === -1) return
      try {
        finish(JSON.parse(buf.slice(0, end)))
      } catch {
        finish(null)
      }
    })
    conn.on('error', () => finish(null))
    conn.on('close', () => finish(null))
  })
}
