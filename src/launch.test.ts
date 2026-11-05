import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { tagLaunch } from './launch'

const NEW_ID = '11111111-2222-4333-8444-555555555555'
const OLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const fixedId = () => NEW_ID

function tag(command: string, agent = 'claude') {
  return tagLaunch(agent, command, fixedId)
}

function assertUntouched(command: string, agent = 'claude') {
  assert.deepEqual(tag(command, agent), { command, session: null })
}

describe('tagLaunch: new Claude Code sessions', () => {
  test('plain claude gets a new session id', () => {
    assert.deepEqual(tag('claude'), {
      command: `claude --session-id ${NEW_ID}`,
      session: { id: NEW_ID, kind: 'new' },
    })
  })

  test('a quoted prompt stays last and byte for byte the same', () => {
    const r = tag(`claude --model opus 'fix the "flaky" test; then stop'`)
    assert.equal(r.command, `claude --session-id ${NEW_ID} --model opus 'fix the "flaky" test; then stop'`)
    assert.deepEqual(r.session, { id: NEW_ID, kind: 'new' })
  })

  test('a double-quoted prompt with escapes is kept', () => {
    const r = tag('claude "say \\"hi\\""')
    assert.equal(r.command, `claude --session-id ${NEW_ID} "say \\"hi\\""`)
  })

  test('an absolute-path claude is tagged', () => {
    assert.equal(tag('/usr/local/bin/claude').command, `/usr/local/bin/claude --session-id ${NEW_ID}`)
  })

  test('an env-prefixed claude is tagged after the program word', () => {
    const r = tag("FOO=1 BAR='a b' claude 'hello'")
    assert.equal(r.command, `FOO=1 BAR='a b' claude --session-id ${NEW_ID} 'hello'`)
    assert.deepEqual(r.session, { id: NEW_ID, kind: 'new' })
  })

  test('an existing --session-id is kept and tracked', () => {
    assertCommandKept(`claude --session-id ${OLD_ID}`, { id: OLD_ID, kind: 'new' })
    assertCommandKept(`claude --session-id=${OLD_ID} 'go'`, { id: OLD_ID, kind: 'new' })
  })

  test('an existing --session-id that is not a uuid is left alone and untracked', () => {
    assertUntouched('claude --session-id nope')
  })

  test('the default id comes from crypto.randomUUID', () => {
    const r = tagLaunch('claude', 'claude')
    assert.match(r.session?.id ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(r.command, `claude --session-id ${r.session?.id}`)
  })
})

describe('tagLaunch: resumed sessions', () => {
  test('--resume <uuid> keeps that uuid', () => {
    assertCommandKept(`claude --resume ${OLD_ID}`, { id: OLD_ID, kind: 'resume' })
  })

  test('-r <uuid> keeps that uuid', () => {
    assertCommandKept(`claude -r ${OLD_ID}`, { id: OLD_ID, kind: 'resume' })
  })

  test('--resume=<uuid> keeps that uuid', () => {
    assertCommandKept(`claude --resume=${OLD_ID}`, { id: OLD_ID, kind: 'resume' })
  })

  test('--resume <name> is untracked', () => {
    assertUntouched('claude --resume my-session')
  })

  test('--resume alone is untracked', () => {
    assertUntouched('claude --resume')
    assertUntouched('claude --resume --model opus')
  })

  test('--continue and -c are untracked', () => {
    assertUntouched('claude --continue')
    assertUntouched("claude -c 'next step'")
  })

  test('--fork-session with a resume is untracked', () => {
    assertUntouched(`claude --resume ${OLD_ID} --fork-session`)
    assertUntouched('claude --continue --fork-session')
  })
})

describe('tagLaunch: launches it leaves alone', () => {
  test('codex is untracked', () => {
    assertUntouched('codex')
    assertUntouched("codex 'fix it'", 'codex')
  })

  test('the agent field rules, not the command', () => {
    assertUntouched('claude', 'codex')
  })

  test('a quoted path that contains "claude" is not claude', () => {
    assertUntouched('"/opt/claude tools/run"')
    assertUntouched("codex --cd '/work/claude'")
    assertUntouched('/usr/local/bin/claude-wrapper')
  })

  test('a "claude" word as an argument is not the program', () => {
    assertUntouched('npx claude')
  })

  test('unparseable commands are unchanged', () => {
    assertUntouched("claude 'open quote")
    assertUntouched('claude "open quote')
    assertUntouched('claude && echo done')
    assertUntouched('claude | tee log')
    assertUntouched('claude "$PROMPT"')
    assertUntouched('claude $(cat prompt)')
    assertUntouched('claude > out.txt')
    assertUntouched('')
  })
})

function assertCommandKept(command: string, session: { id: string; kind: 'new' | 'resume' }) {
  assert.deepEqual(tag(command), { command, session })
}
