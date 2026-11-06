#!/usr/bin/env node
// The UserPromptSubmit hook the launch hook gives each tracked Claude Code session. It tells the worker a turn
// starts (prompt-start), then prints the inbox text (inbox-text). Claude Code adds a UserPromptSubmit command's
// stdout to the prompt as context when it exits 0. On a timeout or an error it prints nothing and exits 0, so the
// prompt goes on as typed. Plain Node with no dependencies, and no state.
//
// Args: --socket <path> --session <id> [--timeout <ms>]
import { ask, readArgs } from './ask.mjs'

const { socket, session, timeout } = readArgs(process.argv.slice(2))
const deadline = Date.now() + timeout
const left = () => Math.max(0, deadline - Date.now())

/** The hook's JSON on stdin, or null when it does not end in time or does not parse. */
function readInput() {
  return new Promise(resolve => {
    let text = ''
    const timer = setTimeout(() => resolve(null), left())
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (text += chunk))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    })
    process.stdin.on('error', () => resolve(null))
  })
}

async function main() {
  const input = await readInput()
  // After /clear the terminal runs a new session the plugin does not track: its prompts are not this session's.
  if (!input || (typeof input.session_id === 'string' && input.session_id !== session)) return
  // The session's folder, for its plan file: the worker has no transcript to read it from at the first prompt.
  const cwd = typeof input.cwd === 'string' ? { cwd: input.cwd } : {}
  // Orca's handle for this terminal, which the agent's process got and this hook inherits. The worker binds a launch
  // Orca gave no terminal id with it.
  const handle = process.env.ORCA_TERMINAL_HANDLE
  const terminal = typeof handle === 'string' && handle !== '' ? { terminalId: handle } : {}
  const started = await ask(socket, { type: 'prompt-start', sessionId: session, ...cwd, ...terminal }, left())
  if (typeof started?.text !== 'string') return
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const answer = await ask(socket, { type: 'inbox-text', sessionId: session, prompt, ...cwd }, left())
  if (typeof answer?.text === 'string' && answer.text !== '') process.stdout.write(`${answer.text}\n`)
}

// No process.exit: on macOS a pipe write ends after this returns. Nothing is left open, so Node exits by itself.
main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0
    process.stdin.destroy()
  })
