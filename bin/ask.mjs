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

/** The worker read the request but gave no answer it can parse: the request may have been saved. */
export const MAYBE_SAVED = { maybeSaved: true }

/**
 * Sends one request line and reads one answer line: the parsed answer when it has a string `text` or an `error`; null
 * on an error or a close before the request is written; or MAYBE_SAVED on a timeout, an error, a close with no answer
 * or any other answer after the write.
 */
export function ask(socket, request, timeoutMs) {
  return new Promise(resolve => {
    let buf = ''
    let written = false
    const conn = connect(socket)
    const timer = setTimeout(() => fail(), timeoutMs)
    function finish(answer) {
      clearTimeout(timer)
      conn.destroy()
      resolve(answer)
    }
    const fail = () => finish(written ? MAYBE_SAVED : null)
    conn.setEncoding('utf8')
    conn.on('connect', () => {
      conn.write(`${JSON.stringify(request)}\n`)
      written = true
    })
    conn.on('data', chunk => {
      buf += chunk
      const end = buf.indexOf('\n')
      if (end === -1) return
      try {
        const answer = JSON.parse(buf.slice(0, end))
        finish(typeof answer?.text === 'string' || answer?.error !== undefined ? answer : MAYBE_SAVED)
      } catch {
        fail()
      }
    })
    conn.on('error', fail)
    conn.on('close', fail)
  })
}
