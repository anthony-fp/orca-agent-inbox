// Ported from the inbox repo's tests/plan.test.ts. The test bodies are unchanged; `expect` below maps the
// matchers they use onto node:assert.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parsePlan, planGoal, planLines, planNote, planPath } from './plan'

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toContain: (expected: string) => assert.ok(String(actual).includes(expected), `expected to contain ${expected}`),
    toMatch: (expected: RegExp) => assert.match(String(actual), expected),
    not: {
      toContain: (expected: string) => assert.ok(!String(actual).includes(expected), `expected not to contain ${expected}`),
    },
  }
}

describe('parsePlan', () => {
  test('reads tasks, marks and counts', () => {
    const plan = parsePlan('## A\n- [x] one\n- [~] two\n## B\n- [ ] three')
    expect(plan?.tasks.map(t => t.title)).toEqual(['A', 'B'])
    expect(plan?.done).toBe(1)
    expect(plan?.total).toBe(3)
    expect(plan?.current).toEqual([{ text: 'two', mark: 'current' }])
    expect(plan?.tasks.map(t => t.isOpen)).toEqual([true, false])
  })

  test('keeps every task with a current step open', () => {
    const plan = parsePlan('## A\n- [~] one\n## B\n- [~] two\n## C\n- [ ] three')
    expect(plan?.tasks.map(t => t.isOpen)).toEqual([true, true, false])
    expect(plan?.current.map(s => s.text)).toEqual(['one', 'two'])
  })

  test('puts steps before any heading in an untitled task', () => {
    expect(parsePlan('- [ ] first\n## A\n- [ ] second')?.tasks.map(t => t.title)).toEqual(['', 'A'])
  })

  test('reads upper-case x, indented steps and star bullets, and skips other lines', () => {
    const plan = parsePlan('## A\nprose\n- [X] up\n  - [ ] nested\n* [~] star\n- plain')
    expect(plan?.tasks[0]?.steps).toEqual([
      { text: 'up', mark: 'done' },
      { text: 'nested', mark: 'waiting' },
      { text: 'star', mark: 'current' },
    ])
  })

  test('returns null when the text holds no step', () => {
    expect(parsePlan('')).toBeNull()
    expect(parsePlan('# Title\nprose')).toBeNull()
  })

  test('drops a heading with no steps', () => {
    expect(parsePlan('# Plan\n## A\n- [ ] one')?.tasks.map(t => t.title)).toEqual(['A'])
  })
})

// Not from the inbox repo: the goal line (docs/goal-line-spec.md).
describe('planGoal', () => {
  test('gives the first `## ` heading, trimmed', () => {
    assert.equal(planGoal('# Plan\n##  Fix the parser  \n- [ ] one\n## Ship it\n'), 'Fix the parser')
  })
  test('`### ` and `#` headings do not count', () => {
    assert.equal(planGoal('# Plan\n### Detail\n####x\n## Goal\n'), 'Goal')
    assert.equal(planGoal('# Plan\n### Detail\n- [ ] one\n'), null)
  })
  test('no heading gives null', () => {
    assert.equal(planGoal('- [ ] one\n'), null)
    assert.equal(planGoal(''), null)
    assert.equal(planGoal('##    \n'), null)
  })
})

describe('planPath', () => {
  test('puts the plan under .inbox/plans by session id', () => {
    expect(planPath('/w', 'abc')).toBe('/w/.inbox/plans/abc.md')
  })
})

describe('planNote', () => {
  const path = '/w/.inbox/plans/abc.md'

  test('names the path, the three-step rule, the marks and when to change them', () => {
    const note = planNote(path, null)
    expect(note).toContain(path)
    expect(note).toContain('three or more steps')
    expect(note).toContain('`- [ ]`')
    expect(note).toContain('`- [~]`')
    expect(note).toContain('`- [x]`')
    expect(note).toMatch(/`\[~\]` when you start/)
    expect(note).toMatch(/`\[x\]` when you finish/)
  })

  test("lists each current step's text", () => {
    const note = planNote(path, parsePlan('## A\n- [x] one\n- [~] two\n## B\n- [~] three\n- [ ] four'))
    expect(note).toContain('two')
    expect(note).toContain('three')
    expect(note).not.toContain('four')
  })
})

describe('planLines', () => {
  const plan = parsePlan(
    [
      '## Store',
      '- [x] one',
      '- [x] two',
      '- [x] three',
      '## Reads',
      '- [x] four',
      '- [x] five',
      '- [~] six',
      '- [ ] seven',
      '## Tests',
      '- [ ] eight',
      '- [ ] nine',
      '- [ ] ten',
      '## Docs',
      '- [ ] eleven',
      '- [ ] twelve',
    ].join('\n'),
  )

  test('starts with the done count and a bar', () => {
    const lines = planLines(plan, null)
    expect(lines[0]).toEqual({ text: 'PLAN  5 of 12 steps', tone: null, isBold: true, indent: 0 })
    expect(lines[1]?.text).toMatch(/^█+░+$/)
    expect([...lines[1]!.text].filter(c => c === '█').length).toBe(Math.round((5 / 12) * [...lines[1]!.text].length))
  })

  test('lists the steps of an open task, and gives each other task one line with its count', () => {
    const texts = planLines(plan, null).map(l => l.text)
    expect(texts.slice(2)).toEqual([
      '✓ Store  3/3',
      '▾ Reads  2/4',
      '✓ four',
      '✓ five',
      '◐ six',
      '○ seven',
      '▸ Tests  0/3',
      '▸ Docs  0/2',
    ])
  })

  test('colors done steps done, current steps needsYou and bold, waiting steps plain and counts dim', () => {
    const line = (text: string) => planLines(plan, null).find(l => l.text === text)
    expect(line('✓ four')).toEqual({ text: '✓ four', tone: 'done', isBold: false, indent: 2 })
    expect(line('◐ six')).toEqual({ text: '◐ six', tone: 'needsYou', isBold: true, indent: 2 })
    expect(line('○ seven')).toEqual({ text: '○ seven', tone: null, isBold: false, indent: 2 })
    expect(line('▸ Tests  0/3')?.tone).toBe('dim')
    expect(line('✓ Store  3/3')?.tone).toBe('done')
  })

  test('draws nothing without a plan', () => {
    expect(planLines(null, null)).toEqual([])
  })

  test('says which file it could not read', () => {
    expect(planLines(null, '/w/.inbox/plans/abc.md')).toEqual([
      { text: 'Could not read the plan: /w/.inbox/plans/abc.md', tone: 'error', isBold: false, indent: 0 },
    ])
  })
})
