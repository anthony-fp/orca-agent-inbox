import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { copyToClipboard, type ClipboardProcess, type ClipboardSpawn } from './clipboard'

/** How each tool behaves: `missing` fails to start, a number exits with it. A tool not listed exits 0. */
type Script = Record<string, 'missing' | number>

/** A stand-in for the platform's tools that records each start and the text it got. */
function stub(script: Script = {}) {
  const calls: { command: string; args: string[]; stdin: string }[] = []
  const spawn: ClipboardSpawn = (command, args) => {
    const proc = new EventEmitter()
    const call = { command, args, stdin: '' }
    calls.push(call)
    const outcome = script[command.split(/[\\/]/).pop()!] ?? 0
    const child = {
      stdin: {
        on: () => {},
        end(text: string) {
          call.stdin = text
          setImmediate(() =>
            outcome === 'missing' ? proc.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })) : proc.emit('exit', outcome),
          )
        },
      },
      on: (event: string, fn: (...a: any[]) => void) => proc.on(event, fn),
    }
    return child as unknown as ClipboardProcess
  }
  return { spawn, calls }
}

test('macOS copies through pbcopy', async () => {
  const s = stub()
  await copyToClipboard('hello', { platform: 'darwin', spawn: s.spawn })
  assert.deepEqual(s.calls, [{ command: 'pbcopy', args: [], stdin: 'hello' }])
})

test('Linux tries wl-copy, xclip and xsel in order, and stops at the first that works', async () => {
  const s = stub({ 'wl-copy': 'missing' })
  await copyToClipboard('hello', { platform: 'linux', spawn: s.spawn })
  assert.deepEqual(
    s.calls.map(c => [c.command, ...c.args]),
    [['wl-copy'], ['xclip', '-selection', 'clipboard']],
  )
  assert.equal(s.calls[1]?.stdin, 'hello')

  const all = stub({ 'wl-copy': 'missing', xclip: 1 })
  await copyToClipboard('hello', { platform: 'linux', spawn: all.spawn })
  assert.deepEqual(all.calls.map(c => c.command), ['wl-copy', 'xclip', 'xsel'])
  assert.deepEqual(all.calls[2]?.args, ['--clipboard', '--input'])
})

test('Windows copies through PowerShell Set-Clipboard', async () => {
  const s = stub()
  await copyToClipboard('héllo', { platform: 'win32', spawn: s.spawn })
  assert.equal(s.calls.length, 1)
  assert.match(s.calls[0]!.command, /powershell\.exe$/)
  assert.match(s.calls[0]!.args.at(-1)!, /Set-Clipboard/)
  assert.equal(s.calls[0]!.stdin, 'héllo')
})

test('no clipboard tool gives an error', async () => {
  const none = stub({ 'wl-copy': 'missing', xclip: 'missing', xsel: 'missing' })
  await assert.rejects(copyToClipboard('hello', { platform: 'linux', spawn: none.spawn }), /no clipboard tool worked \(tried wl-copy, xclip, xsel\)/)
  assert.equal(none.calls.length, 3)

  const other = stub()
  await assert.rejects(copyToClipboard('hello', { platform: 'aix', spawn: other.spawn }), /no clipboard tool on aix/)
  assert.equal(other.calls.length, 0)
})
