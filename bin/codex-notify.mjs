#!/usr/bin/env node
// Codex's turn-end notify: report only ids to the worker, then run the person's configured notify.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ask, TIMEOUT_MS } from './ask.mjs'

/** The socket never receives Codex's input messages or last assistant message. */
export function notifyRequest(payload, env = process.env) {
  const home = env.CODEX_HOME
  const paneKey = env.ORCA_PANE_KEY
  if (!paneKey || !home || typeof payload?.['thread-id'] !== 'string' || !payload['thread-id']) return null
  return {
    type: 'codex-turn',
    payload: {
      paneKey, codexHome: home, threadId: payload['thread-id'],
      turnId: typeof payload['turn-id'] === 'string' ? payload['turn-id'] : '',
      type: typeof payload.type === 'string' ? payload.type : '',
    },
  }
}

/** The top-level TOML `notify` array. Codex's command arrays contain strings only. */
export function notifyCommand(toml) {
  const beforeTable = toml.split(/^\s*\[/m, 1)[0]
  const match = /^\s*notify\s*=\s*(\[)/m.exec(beforeTable)
  if (!match) return null
  const input = beforeTable.slice(match.index + match[0].length - 1)
  const args = []
  let i = 1
  for (;;) {
    while (/\s|,/.test(input[i] ?? '') && i < input.length) i++
    if (input[i] === '#') {
      while (i < input.length && input[i] !== '\n') i++
      continue
    }
    if (input[i] === ']') return args.length > 0 ? args : null
    const quote = input[i]
    if (quote !== '"' && quote !== "'") return null
    const start = i++
    if (quote === "'") {
      const end = input.indexOf("'", i)
      if (end < 0) return null
      args.push(input.slice(i, end))
      i = end + 1
    } else {
      for (; i < input.length; i++) {
        if (input[i] === '\\') { i++; continue }
        if (input[i] === '"') break
      }
      if (i >= input.length) return null
      try { args.push(JSON.parse(input.slice(start, i + 1))) } catch { return null }
      i++
    }
    while (/\s/.test(input[i] ?? '') && i < input.length) i++
    if (input[i] !== ',' && input[i] !== ']') return null
  }
}

async function userNotify(home, rawPayload) {
  let command = null
  try { command = notifyCommand(await readFile(join(home, 'config.toml'), 'utf8')) } catch { return }
  if (!command) return
  await new Promise(resolve => {
    const child = spawn(command[0], [...command.slice(1), rawPayload], { stdio: 'ignore' })
    child.on('error', resolve)
    child.on('close', resolve)
  })
}

export async function main(socket, rawPayload, env = process.env) {
  let payload
  try { payload = JSON.parse(rawPayload) } catch { return }
  const request = notifyRequest(payload, env)
  if (request) await ask(socket, request, TIMEOUT_MS)
  if (env.CODEX_HOME) await userNotify(env.CODEX_HOME, rawPayload)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv[2] ?? '', process.argv[3] ?? '').catch(() => undefined)
