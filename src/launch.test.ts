import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { guidanceText, ORCA, ORCA_CODEX } from './core/model-text'
import { tagLaunch, tokenize } from './launch'

const NEW_ID = '11111111-2222-4333-8444-555555555555'
const OLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const fixedId = () => NEW_ID

function tag(command: string, agent = 'claude') {
  return tagLaunch(agent, command, fixedId)
}

function assertUntouched(command: string, agent = 'claude') {
  assert.deepEqual(tag(command, agent), { command, session: null, tools: false })
}

describe('tagLaunch: new Claude Code sessions', () => {
  test('plain claude gets a new session id', () => {
    assert.deepEqual(tag('claude'), {
      command: `claude --session-id ${NEW_ID}`,
      session: { id: NEW_ID, kind: 'new' },
      tools: false,
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
  test('codex without inbox tools is untracked', () => {
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
  assert.deepEqual(tag(command), { command, session, tools: false })
}

// Paths with a space and a quote, to prove the quoting.
const TOOLS = {
  socketPath: "/tmp/orca inbox/it's.sock",
  mcpServer: '/plugins/agent inbox/bin/mcp-server.mjs',
  promptHook: '/plugins/agent inbox/bin/prompt-hook.mjs',
}

function withTools(command: string, agent = 'claude') {
  return tagLaunch(agent, command, fixedId, TOOLS)
}

function words(command: string): string[] {
  const tokens = tokenize(command)
  assert.ok(tokens, `does not tokenize: ${command}`)
  return tokens.map((t) => t.text)
}

/** The values the three tool flags must carry for session `id`. */
function expectedToolWords(id: string): string[] {
  const mcp = { mcpServers: { 'orca-inbox': { command: 'node', args: [TOOLS.mcpServer, '--socket', TOOLS.socketPath, '--session', id] } } }
  const hook = `'node' '${TOOLS.promptHook}' '--socket' '/tmp/orca inbox/it'\\''s.sock' '--session' '${id}'`
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook }] }] } }
  return [
    '--mcp-config', JSON.stringify(mcp),
    '--append-system-prompt', guidanceText(ORCA),
    '--settings', JSON.stringify(settings),
  ]
}

describe('tagLaunch: the inbox tools', () => {
  test('a new session gets the three flags after --session-id, and they tokenize back exactly', () => {
    const r = withTools('claude')
    assert.deepEqual(r.session, { id: NEW_ID, kind: 'new' })
    assert.equal(r.tools, true)
    assert.deepEqual(words(r.command), ['claude', '--session-id', NEW_ID, ...expectedToolWords(NEW_ID)])
  })

  test('the guidance survives byte for byte, with its newlines and quotes', () => {
    const g = guidanceText(ORCA)
    assert.ok(g.includes('\n') && g.includes("'"), 'the guidance should test newlines and quotes')
    assert.ok(!g.startsWith('-'), 'a value that starts with - would read as a flag')
    const w = words(withTools('claude').command)
    assert.equal(w[w.indexOf('--append-system-prompt') + 1], g)
  })

  test('the hook command runs the prompt hook with the right words', () => {
    const w = words(withTools('claude').command)
    const settings = JSON.parse(w[w.indexOf('--settings') + 1])
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0]
    assert.equal(hook.type, 'command')
    assert.deepEqual(words(hook.command), ['node', TOOLS.promptHook, '--socket', TOOLS.socketPath, '--session', NEW_ID])
  })

  test('a prompt argument still comes last, byte for byte', () => {
    const prompt = `'fix the "flaky" test; then stop'`
    const r = withTools(`FOO=1 claude --model opus ${prompt}`)
    assert.ok(r.command.startsWith(`FOO=1 claude --session-id ${NEW_ID} --mcp-config `))
    assert.ok(r.command.endsWith(` --model opus ${prompt}`))
    assert.deepEqual(words(r.command).slice(-3), ['--model', 'opus', 'fix the "flaky" test; then stop'])
  })

  test('--mcp-config takes several values, so a flag follows it', () => {
    const w = words(withTools("claude 'hello'").command)
    assert.equal(w[w.indexOf('--mcp-config') + 2], '--append-system-prompt')
  })

  test('a resume gets the tools for its own session id', () => {
    const r = withTools(`claude --resume ${OLD_ID} 'go on'`)
    assert.deepEqual(r.session, { id: OLD_ID, kind: 'resume' })
    assert.equal(r.tools, true)
    assert.deepEqual(words(r.command), ['claude', ...expectedToolWords(OLD_ID), '--resume', OLD_ID, 'go on'])
  })

  test('an existing --session-id gets the tools for that id', () => {
    const r = withTools(`claude --session-id ${OLD_ID}`)
    assert.equal(r.tools, true)
    assert.deepEqual(words(r.command), ['claude', ...expectedToolWords(OLD_ID), '--session-id', OLD_ID])
  })

  for (const flag of [
    `--mcp-config '{"mcpServers":{}}'`,
    `--mcp-config='{"mcpServers":{}}'`,
    '--strict-mcp-config',
    "--append-system-prompt 'be brief'",
    '--append-system-prompt-file notes.txt',
    "--system-prompt 'be brief'",
    '--system-prompt-file prompt.txt',
    `--settings '{"model":"opus"}'`,
    '--settings=settings.json',
  ]) {
    test(`${flag.split(/[ =]/)[0]} skips the tools but still tags the session (${flag})`, () => {
      const command = `claude ${flag} 'hi'`
      assert.deepEqual(withTools(command), {
        command: `claude --session-id ${NEW_ID} ${flag} 'hi'`,
        session: { id: NEW_ID, kind: 'new' },
        tools: false,
      })
    })
  }

  test('a skip flag on a resume keeps the command unchanged and tracked', () => {
    const command = `claude --resume ${OLD_ID} --strict-mcp-config`
    assert.deepEqual(withTools(command), { command, session: { id: OLD_ID, kind: 'resume' }, tools: false })
  })

  test('a skip flag after -- is a prompt word, not a flag', () => {
    assert.equal(withTools("claude -- '--settings'").tools, true)
  })

  test('untracked launches stay unchanged with tools given', () => {
    for (const [command, agent] of [
      ['claude', 'codex'],
      ['claude --continue', 'claude'],
      ['claude && echo done', 'claude'],
    ]) {
      assert.deepEqual(withTools(command, agent), { command, session: null, tools: false })
    }
  })

  test('the added length stays far under the shell limit', () => {
    const added = withTools('claude').command.length - 'claude'.length
    console.log(`tool flags add ${added} characters`)
    assert.ok(added < 32_000)
  })
})

function codexValues(command: string): Map<string, string> {
  const w = words(command)
  const values = new Map<string, string>()
  for (let i = 1; i < w.length; i += 2) {
    if (w[i] !== '-c') break
    const value = w[i + 1]
    const eq = value.indexOf('=')
    assert.ok(eq > 0)
    values.set(value.slice(0, eq), value.slice(eq + 1))
  }
  return values
}

describe('tagLaunch: Codex', () => {
  test('plain codex gets the seven TOML config values', () => {
    const r = withTools('codex', 'codex')
    assert.deepEqual(r.session, { kind: 'codex' })
    assert.equal(r.tools, true)
    const values = codexValues(r.command)
    assert.deepEqual([...values.keys()], [
      'notify', 'mcp_servers.orca-inbox.command', 'mcp_servers.orca-inbox.args',
      'mcp_servers.orca-inbox.env_vars', 'mcp_servers.orca-inbox.default_tools_approval_mode',
      'developer_instructions', 'hooks.UserPromptSubmit',
    ])
    assert.deepEqual(JSON.parse(values.get('notify')!), ['node', '/plugins/agent inbox/bin/codex-notify.mjs', TOOLS.socketPath])
    assert.equal(JSON.parse(values.get('mcp_servers.orca-inbox.command')!), 'node')
    assert.deepEqual(JSON.parse(values.get('mcp_servers.orca-inbox.args')!), [TOOLS.mcpServer, '--socket', TOOLS.socketPath])
    assert.deepEqual(JSON.parse(values.get('mcp_servers.orca-inbox.env_vars')!), ['ORCA_PANE_KEY', 'CODEX_HOME'])
    assert.equal(JSON.parse(values.get('mcp_servers.orca-inbox.default_tools_approval_mode')!), 'approve')
    assert.equal(JSON.parse(values.get('developer_instructions')!), guidanceText(ORCA_CODEX))
    const hook = /^\[\{hooks=\[\{type="command",command=("(?:[^"\\]|\\.)*")\}\]\}\]$/.exec(values.get('hooks.UserPromptSubmit') ?? '')
    assert.ok(hook, 'a TOML inline table with one command hook')
    assert.deepEqual(words(JSON.parse(hook[1])), ['node', TOOLS.promptHook, '--socket', TOOLS.socketPath])
  })

  test('Codex parses the generated TOML values when installed', t => {
    const args = words(withTools('codex', 'codex').command).slice(1)
    const home = mkdtempSync(join(tmpdir(), 'inbox-codex-config-'))
    try {
      const parsed = spawnSync('codex', [...args, 'features', 'list'], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, CODEX_HOME: home },
      })
      if ((parsed.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return t.skip('Codex is not installed')
      assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message || 'Codex rejected the config')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('prompt and resume arguments stay last; the hook command is identical across launches', () => {
    const plain = withTools('codex', 'codex')
    const prompt = withTools("codex --model gpt-6 'fix the parser'", 'codex')
    const resume = withTools('codex resume thread-1', 'codex')
    assert.ok(prompt.command.endsWith(" --model gpt-6 'fix the parser'"))
    assert.ok(resume.command.endsWith(' resume thread-1'))
    for (const r of [prompt, resume]) {
      assert.deepEqual(r.session, { kind: 'codex' })
      assert.equal(codexValues(r.command).get('hooks.UserPromptSubmit'), codexValues(plain.command).get('hooks.UserPromptSubmit'))
    }
  })

  test('an unrelated user config stays after the added flags', () => {
    const command = `codex -c 'model="gpt-6"' 'fix it'`
    const r = withTools(command, 'codex')
    assert.equal(r.session?.kind, 'codex')
    assert.ok(r.command.endsWith(` -c 'model="gpt-6"' 'fix it'`))
    assert.equal(codexValues(r.command).get('model'), '"gpt-6"')
  })

  test('exec, a different command, and an unparseable command are untracked', () => {
    for (const command of ['codex exec', 'codex --model gpt-6 exec', 'claude', 'codex && echo done'])
      assert.deepEqual(withTools(command, 'codex'), { command, session: null, tools: false })
  })

  test('a prompt after -- can contain the word exec', () => {
    assert.deepEqual(withTools("codex -- 'exec'", 'codex').session, { kind: 'codex' })
  })

  for (const config of [
    'notify=[]', 'mcp_servers.orca-inbox.command="other"', 'mcp_servers.orca-inbox={command="other"}',
    'developer_instructions="other"',
  ]) {
    test(`existing ${config.split('=')[0]} leaves the launch alone`, () => {
      const command = `codex -c '${config}' 'hello'`
      assert.deepEqual(withTools(command, 'codex'), { command, session: null, tools: false })
    })
  }

  test('an inline --config clash leaves the launch alone', () => {
    const command = `codex --config='notify=[]' 'hello'`
    assert.deepEqual(withTools(command, 'codex'), { command, session: null, tools: false })
  })
})
