// Ported from the inbox repo's tests/ledger.test.ts: the tests that call recordItem, recordClose and agentTools.
// The test bodies are unchanged; `expect` below maps the matchers they use onto node:assert.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import { CLAUDE_CODE, MAX_TOOL_DESCRIPTION, ORCA, guidedCloseDescription, systemText } from './model-text'
import { EMPTY, addAgentItem, addFinding, closeByAgent, closeFinding, closeItem } from './ledger'
import { agentTools, recordClose, recordItem } from './tools'

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toContain: (expected: string) => assert.ok(String(actual).includes(expected), `expected to contain ${expected}`),
    toStartWith: (expected: string) => assert.ok(String(actual).startsWith(expected), `expected to start with ${expected}`),
    toMatchObject: (expected: Record<string, unknown>) => {
      const picked = Object.fromEntries(Object.keys(expected).map(k => [k, (actual as Record<string, unknown>)[k]]))
      assert.deepEqual(picked, expected)
    },
    toBeLessThanOrEqual: (expected: number) => assert.ok((actual as number) <= expected, `${actual} > ${expected}`),
  }
}

describe('items the agent recorded', () => {
  const ask = {
    kind: 'question' as const,
    ask: 'Which cache should the API use?',
    options: ['Redis', 'Memcached'],
    rec: null,
    helps: [],
  }
  const recorded = (turn = 1) => addAgentItem({ ...EMPTY, turn }, ask, 1000).ledger

  test('the agent can record again what it closed, but not what the person or the update closed', () => {
    const closedByAgent = closeByAgent(
      CLAUDE_CODE,
      recorded(),
      'i1',
      { reason: 'no longer applies: cache dropped' },
      1500,
    )
    expect(addAgentItem(closedByAgent.ledger, { ...ask, rec: 'Redis' }, 2000)).toMatchObject({ is: 'added', id: 'i2' })
    const refusals = [
      [{ how: 'answered', outcome: 'Redis' }, 'Not recorded: the user answered it (Redis).'],
      [{ how: 'dismissed', outcome: 'dismissed' }, 'Not recorded: the user dismissed it.'],
      [{ how: 'update', outcome: 'Redis' }, 'Not recorded: the inbox closed it (Redis).'],
    ] as const
    for (const [closing, result] of refusals)
      expect(recordItem(CLAUDE_CODE, closeItem(recorded(), 'i1', closing, 1500), ask, 2000).result).toStartWith(result)
  })
})

describe('reopening', () => {
  test('closing an id that is already closed says how it closed and changes nothing', () => {
    const finding = { kind: 'issue' as const, title: 'Hotkeys vanish', detail: 'In ANSI', path: null, at: 1 }
    const open = addFinding(EMPTY, finding).ledger
    const dismissed = closeFinding(open, 'f1', { how: 'dismissed', outcome: 'dismissed' }, 5)
    const again = recordClose(CLAUDE_CODE, dismissed, { id: 'f1', reason: 'fixed' }, 9)
    expect(again.result).toBe('Already closed: the user dismissed it.')
    expect(again.ledger).toBe(dismissed)
    const fixed = closeFinding(open, 'f1', { how: 'update', outcome: 'fixed in the theme' }, 5)
    expect(recordClose(CLAUDE_CODE, fixed, { id: 'f1', reason: 'x' }, 9).result).toBe(
      'Already closed: the inbox closed it (fixed in the theme).',
    )
    const expired = closeFinding(open, 'f1', { how: 'expired', outcome: 'list full' }, 5)
    expect(recordClose(CLAUDE_CODE, expired, { id: 'f1', reason: 'x' }, 9).result).toBe('Already closed: it expired.')
    expect(recordClose(CLAUDE_CODE, expired, { id: 'f7', reason: 'x' }, 9).result).toContain('Not closed:')
  })
})

describe('guidedCloseDescription', () => {
  test('stays within the length Claude Code sends of a tool description', () => {
    const close = agentTools(CLAUDE_CODE).find(t => t.name === 'close')!
    expect(guidedCloseDescription(CLAUDE_CODE, close.description).length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION)
  })
})

// New here, not ported.
describe('the ORCA host', () => {
  test('systemText(ORCA) is the text the inbox model read before the host got its tool names and intro', () => {
    // The SHA-256 of JSON.stringify(systemText(ORCA)) at the commit before T9 (8301 bytes).
    const hash = createHash('sha256').update(JSON.stringify(systemText(ORCA))).digest('hex')
    expect(hash).toBe('912b9f8c99742d61190d739e02294adacbaaa4c4822e6aebcdf03d55e5a0156b')
  })

  test("the close description stays within the length Claude Code sends, with ORCA's names", () => {
    const close = agentTools(ORCA).find(t => t.name === 'close')!
    expect(guidedCloseDescription(ORCA, close.description).length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION)
  })
})
