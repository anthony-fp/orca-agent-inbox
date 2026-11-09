// Ported from the inbox repo's tests/ledger.test.ts: the REPLY sample, the applyUpdate tests
// (applyExchangeUpdate applies its update through applyUpdate) and the buildPrompt test.
// The test bodies are unchanged; `expect` below maps the matchers they use onto node:assert.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildPrompt, latestBatch } from './model-text'
import { EMPTY, addAgentItem, applyExchangeUpdate, applyUpdate, closeItem, parseReply, upgradeLedger } from './ledger'

/** Drops undefined fields, as the source suite's toEqual ignores them. */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(plain(actual), plain(expected)),
    toContain: (expected: string) => assert.ok(String(actual).includes(expected), `expected to contain ${expected}`),
    toMatchObject: (expected: Record<string, unknown>) => {
      const picked = Object.fromEntries(Object.keys(expected).map(k => [k, (actual as Record<string, unknown>)[k]]))
      assert.deepEqual(plain(picked), plain(expected))
    },
  }
}

const REPLY = `GOAL: Move annotation queue logic into a tested reducer
DONE: Reducer built on its own branch
DONE: 422 unit tests pass
NOW: Waiting on approval to run input tests
RUNNING: vite dev: http://localhost:5173
NEW: decide | 1 | Rename greet.mjs to hello.mjs? | Yes / No | yes
NEW: decide | 2 | Cut CHANGELOG.md down to this release? | - | -
NEW: do | - | Test pinch zoom on your Mac | - | -`


describe('applyUpdate', () => {
  test('numbers new items, closes answered ones, and remembers the batch', () => {
    const first = applyUpdate({ ...EMPTY, turn: 1 }, parseReply(REPLY)!, 1000, 1)
    expect(first.items.map(i => i.id)).toEqual(['i1', 'i2', 'i3'])
    expect(latestBatch(first).length).toBe(3)

    const second = applyUpdate(
      { ...first, turn: 2 },
      parseReply('GOAL: same\nNOW: renamed\nCLOSED: i1 | yes, renamed\nNEW: decide | - | Push the branch? | - | yes')!,
      2000,
      2,
    )
    expect(second.items.map(i => i.id)).toEqual(['i2', 'i3', 'i4'])
    expect(second.closed).toEqual([
      {
        id: 'i1',
        kind: 'question',
        ask: 'Rename greet.mjs to hello.mjs?',
        label: '1',
        outcome: 'yes, renamed',
        how: 'update',
        at: 2000,
        item: first.items[0],
      },
    ])
    expect(latestBatch(second).map(i => i.id)).toEqual(['i4'])
    expect(second.card?.done).toEqual(first.card?.done)
  })

  test('closes items left unanswered for more than 12 prompts as expired', () => {
    const first = applyUpdate({ ...EMPTY, turn: 1 }, parseReply(REPLY)!, 1, 1)
    const later = applyUpdate({ ...first, turn: 14 }, parseReply('NOW: still going')!, 2, 14)
    expect(later.items.length).toBe(0)
    expect(later.closed.map(d => [d.id, d.outcome])).toEqual([
      ['i1', 'expired, unanswered'],
      ['i2', 'expired, unanswered'],
      ['i3', 'expired, unanswered'],
    ])
    expect(applyUpdate({ ...first, turn: 13 }, parseReply('NOW: still going')!, 2, 13).items.length).toBe(3)
  })

  test('merges a reworded copy of an open item instead of adding it', () => {
    const first = applyUpdate(
      EMPTY,
      parseReply('NEW: decide | 2 | Make release backups use cp -n with a letter suffix? | Yes / No | Yes')!,
      1,
      1,
    )
    const again = applyUpdate(
      first,
      parseReply(
        [
          'NEW: decide | - | Use cp -n and a letter suffix for same-day release backups? | Yes / No | Yes',
          'NEW: decide | - | Also back up CHANGELOG.md before triage? | Yes / No | -',
        ].join('\n'),
      )!,
      2,
      2,
    )
    expect(again.items.map(i => i.ask)).toEqual([
      'Make release backups use cp -n with a letter suffix?',
      'Also back up CHANGELOG.md before triage?',
    ])
  })

  test('an UPDATE line gives an open question new options or a recommendation, and leaves tasks alone', () => {
    const first = applyUpdate(EMPTY, parseReply(REPLY)!, 1, 1)
    const recommended = applyUpdate(first, parseReply('UPDATE: i1 | - | No')!, 2, 2)
    expect(recommended.items[0]).toMatchObject({ options: ['Yes', 'No'], rec: 'No' })

    const narrowed = applyUpdate(recommended, parseReply('UPDATE: i1 | hello.mjs / hello.mts | -')!, 3, 3)
    expect(narrowed.items[0]).toMatchObject({ options: ['hello.mjs', 'hello.mts'], rec: null })

    const task = applyUpdate(first, parseReply('UPDATE: i3 | Done / Skip | Done')!, 2, 2)
    expect(task.items[2]).toEqual(first.items[2])
    expect(applyUpdate(first, parseReply('UPDATE: i9 | A / B | A')!, 2, 2).items).toEqual(first.items)
  })

  test('a question naming a different number, or in another script, is not taken for an open one', () => {
    const first = applyUpdate(EMPTY, parseReply('NEW: decide | - | Approve the PR #41 merge? | Yes / No | -')!, 1, 1)
    const second = applyUpdate(first, parseReply('NEW: decide | - | Approve the PR #42 merge? | Yes / No | -')!, 2, 2)
    expect(second.items.map(i => i.ask)).toEqual(['Approve the PR #41 merge?', 'Approve the PR #42 merge?'])

    const tokyo = applyUpdate(EMPTY, parseReply('NEW: decide | - | 東京に移しますか？ | はい / いいえ | -')!, 1, 1)
    const osaka = applyUpdate(tokyo, parseReply('NEW: decide | - | 大阪に移しますか？ | はい / いいえ | -')!, 2, 2)
    expect(osaka.items.length).toBe(2)
  })

  test('an UPDATE keeps a question that a CLOSED line in the same answer names', () => {
    const first = applyUpdate(EMPTY, parseReply(REPLY)!, 1, 1)
    const both = applyUpdate(
      first,
      parseReply('CLOSED: i1 | renamed\nUPDATE: i1 | hello.mjs / hello.mts | hello.mjs')!,
      2,
      2,
    )
    expect(both.items[0]).toMatchObject({ id: 'i1', options: ['hello.mjs', 'hello.mts'], rec: 'hello.mjs' })
  })

  test('questions in the same frame from one batch are all added, and a later turn restating one is not', () => {
    const question = (ask: string) => ({ kind: 'question' as const, ask, options: [], rec: null, helps: [], path: null })
    const license = addAgentItem(EMPTY, question('Which license do you prefer for greet?'), 1).ledger
    const both = addAgentItem(license, question('Which minimum Node version do you prefer for greet?'), 2)
    expect(both.is).toBe('added')
    expect(addAgentItem({ ...both.ledger, turn: 1 }, question('Which license should greet use?'), 3).is).toBe('open')
    const reply =
      'NEW: decide | - | Which license do you prefer for greet? | MIT / Apache-2.0 | -\nNEW: decide | - | Which minimum Node version do you prefer for greet? | 20 / 18 | -'
    expect(applyUpdate(EMPTY, parseReply(reply)!, 1, 1).items.length).toBe(2)
  })

  test('does not add an item that is already open', () => {
    const first = applyUpdate(EMPTY, parseReply(REPLY)!, 1, 1)
    const again = applyUpdate(first, parseReply('NEW: decide | 1 | rename greet.mjs to hello.mjs | - | -')!, 2, 2)
    expect(again.items.length).toBe(3)
  })

  const repeats: [string, string, number, number][] = [
    [
      'the id of an item closed during the update as its label',
      'NEW: decide | i1 | Something else entirely? | - | -',
      5000,
      0,
    ],
    [
      'the ask of an item closed during the update',
      'NEW: decide | - | Rename greet.mjs to hello.mjs? | - | -',
      5000,
      0,
    ],
    [
      'a restated ask of an item closed during the update',
      'NEW: decide | - | Should greet.mjs be renamed to hello.mjs? | - | -',
      5000,
      0,
    ],
    [
      'the label of an item closed during the update',
      'NEW: decide | 1 | Another question altogether? | - | -',
      5000,
      0,
    ],
    [
      'the label of an item closed before the prompt',
      'NEW: decide | 1 | Another question altogether? | - | -',
      6000,
      1,
    ],
    [
      'the ask of an item answered before the prompt',
      'NEW: decide | - | Rename greet.mjs to hello.mjs? | - | -',
      6000,
      0,
    ],
    ['an unrelated question', 'NEW: decide | 9 | Cut CHANGELOG.md down to this release? | - | -', 5000, 1],
    [
      'a follow-up in the words of an item answered before the prompt',
      'NEW: decide | - | Rename greet.mjs to hello.mjs in the docs too? | - | -',
      6000,
      1,
    ],
  ]
  for (const [name, line, promptAt, added] of repeats)
    test(`a NEW line with ${name} is ${added === 0 ? 'dropped' : 'added'}`, () => {
      const first = applyUpdate(
        { ...EMPTY, turn: 1 },
        parseReply('NEW: decide | 1 | Rename greet.mjs to hello.mjs? | - | -')!,
        1000,
        1,
      )
      const answered = closeItem(first, 'i1', { how: 'answered', outcome: 'yes' }, 5500)
      const next = applyUpdate({ ...answered, turn: 2 }, parseReply(line)!, 7000, 2, promptAt)
      expect(next.items.length).toBe(added)
    })

  test('a follow-up to an answered question is recorded, and a rewording of a dismissed one is not', () => {
    const question = (ask: string) => ({ kind: 'question' as const, ask, options: [], rec: null, helps: [], path: null })
    const asked = addAgentItem({ ...EMPTY, turn: 1 }, question('Which cache should the product API use?'), 1).ledger
    const followUp = question('Which cache size should the product API use?')
    const answered = closeItem(asked, 'i1', { how: 'answered', outcome: 'In-memory' }, 2)
    expect(addAgentItem({ ...answered, turn: 2 }, followUp, 3).is).toBe('added')
    const dismissed = closeItem(asked, 'i1', { how: 'dismissed', outcome: 'dismissed' }, 2)
    expect(addAgentItem({ ...dismissed, turn: 2 }, followUp, 3).is).toBe('closed')
    const reworded = parseReply('NEW: decide | - | Which cache should we use for the product API? | - | -')!
    expect(applyUpdate({ ...dismissed, turn: 2 }, reworded, 4, 2, 3).items).toEqual([])
  })

  test('the inbox model can add a question again with choices after the person answered it with List the choices', () => {
    const question = { kind: 'question' as const, ask: 'Where should the job run?', options: [], rec: null, helps: [], path: null }
    const asked = addAgentItem({ ...EMPTY, turn: 1 }, question, 1).ledger
    const reply = parseReply('NEW: decide | - | Where should the job run? | Nightly / Hourly | Nightly')!
    const listed = closeItem(asked, 'i1', { how: 'answered', outcome: 'List the choices' }, 2)
    expect(applyUpdate({ ...listed, turn: 2 }, reply, 4, 2, 3).items.map(i => i.options)).toEqual([
      ['Nightly', 'Hourly'],
    ])
    const other = closeItem(asked, 'i1', { how: 'answered', outcome: 'Nightly' }, 2)
    expect(applyUpdate({ ...other, turn: 2 }, reply, 4, 2, 3).items).toEqual([])
  })

  test('an update that closes an item as no longer applying keeps it open when its reason names nothing that made it moot', () => {
    const open = applyUpdate(
      { ...EMPTY, turn: 1 },
      parseReply('NEW: decide | - | Email failures or post in #ops? | - | -')!,
      1,
      1,
    )
    for (const reason of [
      'not related to this exchange',
      'unrelated, still open',
      'nothing in this exchange touches it',
    ])
      expect(applyUpdate(open, parseReply(`CLOSED: i1 | no longer applies: ${reason}`)!, 2, 2).items.length).toBe(1)
    expect(applyUpdate(open, parseReply('CLOSED: i1 | no longer applies: #ops was archived')!, 2, 2).items).toEqual([])
  })

  test('a NEW line with the ask of an item that expired before the prompt is added', () => {
    const first = applyUpdate(
      { ...EMPTY, turn: 1 },
      parseReply('NEW: decide | 1 | Rename greet.mjs to hello.mjs? | - | -')!,
      1000,
      1,
    )
    const expired = closeItem(first, 'i1', { how: 'expired', outcome: 'expired' }, 5500)
    const next = applyUpdate(
      { ...expired, turn: 2 },
      parseReply('NEW: decide | - | Rename greet.mjs to hello.mjs? | - | -')!,
      7000,
      2,
      6000,
    )
    expect(next.items.length).toBe(1)
  })
})

describe('applyExchangeUpdate', () => {
  test('keeps open the item an Explain press asked about, and closes the rest as applyUpdate does', () => {
    const first = applyUpdate({ ...EMPTY, turn: 1 }, parseReply(REPLY)!, 1000, 1)
    const update = parseReply('CLOSED: i1 | yes\nCLOSED: i2 | no')!
    const ex = { person: null, trigger: null, activity: [], reply: '', turn: 2, press: { id: 'i1', action: 'explain' as const }, screen: '' }
    const next = applyExchangeUpdate({ ...first, turn: 2 }, update, ex, 2000, 2000)
    expect(next.items.map(i => i.id)).toEqual(['i1', 'i3'])
  })

  // The person typed "1" for an earlier question; during the reply the agent recorded the Snooze question, with a
  // turn stamp 2 above the exchange's (subagent hand-backs raise the active turn, not the person-prompt count).
  const snooze = { kind: 'question' as const, ask: 'How long should a snoozed row stay hidden?', options: ['1 hour', 'Until tomorrow 9am', 'Pick 1 hour or tomorrow'], rec: null, helps: [], path: null }
  const recordedDuring = (startedAt: number) => {
    const recorded = addAgentItem({ ...EMPTY, turn: 8 }, snooze, 5000).ledger
    const ledger = { ...recorded, turn: 6 }
    const ex = { person: '1', trigger: null, activity: [], reply: 'Design question 4 of 6: how long should a snoozed row stay hidden?', turn: 6, press: null, screen: '', startedAt }
    return { ledger, ex }
  }
  const copy = 'NEW: decide | 4 | How long does Snooze hide a row? | 1 hour / Until tomorrow 9am | -'

  test('a CLOSED line never closes a question the agent recorded after the person sent the message, nor adds its copy', () => {
    const { ledger, ex } = recordedDuring(4000)
    const next = applyExchangeUpdate(ledger, parseReply(`CLOSED: i1 | 1 hour\n${copy}`)!, ex, 6000, 6000)
    expect(next.items.map(i => [i.id, i.ask])).toEqual([['i1', snooze.ask]])
    expect(next.closed).toEqual([])
  })

  test('a reworded NEW copy of a question the agent recorded during the exchange is dropped', () => {
    const { ledger, ex } = recordedDuring(4000)
    const next = applyExchangeUpdate(ledger, parseReply(copy)!, ex, 6000, 6000)
    expect(next.items.map(i => i.id)).toEqual(['i1'])
  })

  test('a CLOSED line closes a recorded question from an earlier exchange with the person\'s answer', () => {
    const { ledger, ex } = recordedDuring(5500)
    const next = applyExchangeUpdate(ledger, parseReply('CLOSED: i1 | 1 hour')!, ex, 6000, 6000)
    expect(next.items).toEqual([])
    expect(next.closed.map(c => [c.id, c.outcome])).toEqual([['i1', '1 hour']])
  })
})

describe('buildPrompt', () => {
  test('marks an open question the agent recorded after the person sent the message', () => {
    const earlier = addAgentItem({ ...EMPTY, turn: 1 }, { kind: 'question', ask: 'Ship now?', options: ['Yes', 'No'], rec: null, helps: [] }, 1000).ledger
    const ledger = addAgentItem({ ...earlier, turn: 2 }, { kind: 'question', ask: 'Snooze for how long?', options: ['1 hour'], rec: null, helps: [] }, 3000).ledger
    const ex = { person: '1', trigger: null, activity: [], reply: 'Snooze for how long?', turn: 2, startedAt: 2000, press: null, screen: '' }
    const rows = buildPrompt(ledger, ex).split('\n').filter(l => /^i\d/.test(l))
    expect(rows.map(r => r.endsWith(' | asked after <person>'))).toEqual([false, true])
  })

  test('a long reply keeps its opening and its closing question, and long activity keeps its latest lines', () => {
    const reply = `Summary of the work.\n${'Detail line.\n'.repeat(2000)}Ship it now, or wait for review?`
    const activity = Array.from({ length: 400 }, (_, i) => `edited file-${i}.ts`)
    const ex = { person: 'go', trigger: null, activity, reply, turn: 1, press: null, screen: '' }
    const prompt = buildPrompt(EMPTY, ex)
    expect(prompt).toContain('Summary of the work.')
    expect(prompt).toContain('Ship it now, or wait for review?')
    expect(prompt).toContain('edited file-399.ts')
    expect(prompt).toContain('…[cut]')
  })
})

test('an item saved before items kept a path upgrades to path null, open and closed', () => {
  const question = (ask: string) => ({ kind: 'question' as const, ask, options: ['Yes'], rec: null, helps: [], path: null })
  const two = addAgentItem(addAgentItem(EMPTY, question('Keep the cache?'), 1).ledger, question('Ship it now?'), 2).ledger
  const saved = closeItem(two, 'i1', { how: 'answered', outcome: 'Yes' }, 3)
  const old = JSON.parse(JSON.stringify(saved, (key, value) => (key === 'path' ? undefined : value)))
  assert.equal(old.items[0].path, undefined)
  const upgraded = upgradeLedger(old)
  assert.deepEqual(upgraded.items.map(i => i.path), [null])
  assert.deepEqual(upgraded.closed.map(c => c.item?.path), [null])
})
