#!/usr/bin/env node
// The `orca-inbox` MCP server the launch hook gives each tracked Claude Code session: `record` and `close` over stdio
// (newline-delimited JSON-RPC 2.0). Each call goes to the worker's socket, and the worker's answer goes back as the
// tool's result. Plain Node with no dependencies, and no state.
//
// Args: --socket <path> --session <id> [--timeout <ms>]
// The tool list is bin/tools.json: agentTools(ORCA) from src/core/tools.ts, word for word. src/socket.test.ts checks
// it, and `UPDATE_TOOLS=1 npm test` writes it again.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { ask, readArgs } from './ask.mjs'

const { socket, session, timeout } = readArgs(process.argv.slice(2))
const tools = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'))
const names = new Set(tools.map(t => t.name))

/** Used when the client names no version. A client's own version is echoed back: the methods used here are the same in each. */
const PROTOCOL_VERSION = '2025-06-18'
const NOT_AVAILABLE = 'The inbox is not available, so this was not saved.'

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

async function result(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'orca-inbox', version: '0.1.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools }
    case 'tools/call': {
      const name = params?.name
      if (!names.has(name)) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
      const meta = params?._meta
      const turn = meta?.['x-codex-turn-metadata']
      if (!session && turn?.thread_source && turn.thread_source !== 'user')
        return { content: [{ type: 'text', text: NOT_AVAILABLE }], isError: true }
      const paneKey = !session ? process.env.ORCA_PANE_KEY : undefined
      const threadId = !session && turn?.thread_source === 'user' && typeof meta?.threadId === 'string' ? meta.threadId : undefined
      const identity = paneKey ? {
        paneKey, codexHome: process.env.CODEX_HOME || '',
        codexTurnId: typeof turn?.turn_id === 'string' ? turn.turn_id : '',
        ...(threadId ? { sessionId: threadId } : {}),
      } : { sessionId: session }
      const answer = await ask(socket, { type: name, ...identity, args }, timeout)
      return typeof answer?.text === 'string'
        ? { content: [{ type: 'text', text: answer.text }] }
        : { content: [{ type: 'text', text: NOT_AVAILABLE }], isError: true }
    }
    default:
      return undefined
  }
}

createInterface({ input: process.stdin }).on('line', async line => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  // A notification, such as notifications/initialized, has no id and gets no answer.
  if (message?.id === undefined || message.id === null) return
  const out = await result(message.method, message.params)
  send(out === undefined ? { id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } } : { id: message.id, result: out })
})
