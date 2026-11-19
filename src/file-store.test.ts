// The file store (docs/file-store-spec.md, plan F1-F3): the state in one file, migration from Orca storage, the load guard,
// the owner check, and the copy of a state key that changed after migration.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { fileStore, type FileStoreFs } from './file-store'
import type { Item } from './core/types'
import { STATE_KEY, emptySession, emptyState, type CurrentState, type PressLabel } from './state'
import { fakeClock } from './test-clock'
import { createTracker, type Storage } from './turns'

/** Orca storage in memory, with counted calls. */
function fakeBackup(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  const calls = { get: 0, set: 0 }
  return {
    calls,
    data,
    async get(key: string) {
      calls.get++
      return data.get(key)
    },
    async set(key: string, value: unknown) {
      calls.set++
      data.set(key, value)
    },
  }
}

const stateWith = (id: string) => ({ ...emptyState(), sessions: { [id]: emptySession(5) } })
/** Valid JSON that upgradeState throws on: a ledger item that is null (src/state.ts:162, src/core/ledger.ts:76). */
const BAD_STATE = JSON.stringify({ version: 3, sessions: { s: { ledger: { items: [null] } } } })

describe('the file store', () => {
  const dirs: string[] = []
  after(() => {
    for (const d of dirs) {
      chmodSync(d, 0o700)
      rmSync(d, { recursive: true, force: true })
    }
  })
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'oai-'))
    dirs.push(d)
    return d
  }
  const store = (dir: string, backup = fakeBackup(), fs?: Partial<FileStoreFs>) => {
    const lines: string[] = []
    return { lines, backup, store: fileStore({ dir, backup, log: m => lines.push(m), fs }) }
  }
  const temps = (dir: string) => readdirSync(dir).filter(n => n.includes('.tmp-'))

  test('a saved state loads back the same in a new store', async () => {
    const dir = tempDir()
    const a = store(dir).store
    assert.equal(await a.get(STATE_KEY), null)
    await a.set(STATE_KEY, stateWith('s1'))
    assert.deepEqual(await store(dir).store.get(STATE_KEY), stateWith('s1'))
  })

  test('a state over 262144 bytes saves and loads', async () => {
    const dir = tempDir()
    const big = { ...emptyState(), terminals: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`t${i}`, { sessionId: `${i}`.padStart(60, 'x') }])) }
    assert.ok(Buffer.byteLength(JSON.stringify(big)) > 262144)
    const a = store(dir).store
    await a.get(STATE_KEY)
    await a.set(STATE_KEY, big)
    assert.deepEqual(await store(dir).store.get(STATE_KEY), big)
  })

  test('a failed rename rejects, removes its temp file and leaves the old state.json', async () => {
    const dir = tempDir()
    let renames = 0
    const a = store(dir, fakeBackup(), {
      rename: async (from, to) => {
        if (to.endsWith('state.json') && ++renames === 2) throw new Error('rename failed')
        await rename(from, to)
      },
    }).store
    await a.get(STATE_KEY)
    await a.set(STATE_KEY, stateWith('s1'))
    const before = readFileSync(join(dir, 'state.json'))
    await assert.rejects(a.set(STATE_KEY, stateWith('s2')), /rename failed/)
    assert.deepEqual(readFileSync(join(dir, 'state.json')), before)
    assert.deepEqual(temps(dir), [])
  })

  test('a folder that is not writable makes the save reject', { skip: process.getuid?.() === 0 }, async () => {
    const dir = tempDir()
    const a = store(dir).store
    await a.get(STATE_KEY)
    chmodSync(dir, 0o500)
    try {
      await assert.rejects(a.set(STATE_KEY, stateWith('s1')), { code: 'EACCES' })
    } finally {
      chmodSync(dir, 0o700)
    }
    assert.equal(existsSync(join(dir, 'state.json')), false)
    assert.deepEqual(temps(dir), [])
  })

  test('a leftover state.json.tmp-* file, even an old one, is left in place and does not affect load or save', async () => {
    const dir = tempDir()
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    writeFileSync(join(dir, 'state.json.tmp-abcdef'), 'half')
    utimesSync(join(dir, 'state.json.tmp-abcdef'), old, old)
    writeFileSync(join(dir, 'state.json'), JSON.stringify(stateWith('s1')))
    const a = store(dir).store
    assert.deepEqual(await a.get(STATE_KEY), stateWith('s1'))
    await a.set(STATE_KEY, stateWith('s2'))
    assert.deepEqual(await store(dir).store.get(STATE_KEY), stateWith('s2'))
    assert.deepEqual(readdirSync(dir).sort(), ['owner', 'state.json', 'state.json.from', 'state.json.tmp-abcdef'])
    assert.equal(readFileSync(join(dir, 'state.json.tmp-abcdef'), 'utf8'), 'half')
  })

  test('a corrupt state.json is copied aside and the backup state key loads', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'state.json'), '{"version": 3, "sess')
    const s = store(dir, fakeBackup({ [STATE_KEY]: stateWith('b1') }))
    assert.deepEqual(await s.store.get(STATE_KEY), stateWith('b1'))
    const corrupt = readdirSync(dir).filter(n => n.startsWith('state.json.corrupt-'))
    assert.equal(corrupt.length, 1)
    assert.match(corrupt[0]!, /^state\.json\.corrupt-\d+$/)
    assert.equal(readFileSync(join(dir, corrupt[0]!), 'utf8'), '{"version": 3, "sess')
    assert.equal(statSync(join(dir, corrupt[0]!)).mode & 0o777, 0o600)
    assert.deepEqual(s.lines, [`turns: state.json is corrupt, copied to ${corrupt[0]}`])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), stateWith('b1'))
  })

  test('the folder has mode 0700 and state.json 0600, also when the folder existed as 0755', async () => {
    const parent = tempDir()
    const fresh = join(parent, 'new')
    const existing = join(parent, 'old')
    mkdirSync(existing)
    chmodSync(existing, 0o755)
    for (const dir of [fresh, existing]) {
      const a = store(dir).store
      await a.get(STATE_KEY)
      await a.set(STATE_KEY, stateWith('s1'))
      assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
      assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600, dir)
    }
  })

  test('with no state.json the backup state key is copied once, and saves never write it', async () => {
    const dir = tempDir()
    const s = store(dir, fakeBackup({ [STATE_KEY]: stateWith('b1') }))
    assert.deepEqual(await s.store.get(STATE_KEY), stateWith('b1'))
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), stateWith('b1'))
    await s.store.set(STATE_KEY, stateWith('s2'))
    assert.equal(s.backup.calls.set, 0)
    assert.deepEqual(s.backup.data.get(STATE_KEY), stateWith('b1'))
    // The same key: a key that changed is a rollback (F3).
    assert.deepEqual(await store(dir, s.backup).store.get(STATE_KEY), stateWith('s2'))
    assert.equal(s.backup.calls.set, 0)
  })

  test('with no state.json and no backup key, get gives null and writes no state.json', async () => {
    const dir = tempDir()
    assert.equal(await store(dir).store.get(STATE_KEY), null)
    assert.deepEqual(readdirSync(dir).sort(), ['owner', 'state.json.from'])
  })

  describe('the load guard', () => {
    test('a read error latches', async () => {
      const dir = tempDir()
      mkdirSync(join(dir, 'state.json'))
      const a = store(dir).store
      await assert.rejects(a.get(STATE_KEY), { code: 'EISDIR' })
      await assert.rejects(a.set(STATE_KEY, stateWith('s1')), { code: 'EISDIR' })
      assert.ok(statSync(join(dir, 'state.json')).isDirectory())
      assert.deepEqual(readdirSync(join(dir, 'state.json')), [])
    })

    test('parseable state that upgradeState rejects latches', async () => {
      const dir = tempDir()
      writeFileSync(join(dir, 'state.json'), BAD_STATE)
      const a = store(dir).store
      await assert.rejects(a.get(STATE_KEY), TypeError)
      await assert.rejects(a.set(STATE_KEY, stateWith('s1')), TypeError)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), BAD_STATE)
      assert.deepEqual(temps(dir), [])
    })

    test('a backup read that rejects latches', async () => {
      const dir = tempDir()
      const backup = fakeBackup()
      backup.get = async () => {
        throw new Error('backup down')
      }
      const a = store(dir, backup).store
      await assert.rejects(a.get(STATE_KEY), /backup down/)
      await assert.rejects(a.set(STATE_KEY, stateWith('s1')), /backup down/)
      assert.equal(existsSync(join(dir, 'state.json')), false)
    })

    test('a set before the first get rejects', async () => {
      const dir = tempDir()
      writeFileSync(join(dir, 'state.json'), JSON.stringify(stateWith('s1')))
      const before = readFileSync(join(dir, 'state.json'))
      await assert.rejects(store(dir).store.set(STATE_KEY, stateWith('s2')), /before the state loads/)
      assert.deepEqual(readFileSync(join(dir, 'state.json')), before)
      assert.deepEqual(temps(dir), [])
    })
  })

  describe('failure paths', () => {
    test('a failed migration write rejects get, latches, and leaves no state.json and no temp file', async () => {
      const dir = tempDir()
      const a = store(dir, fakeBackup({ [STATE_KEY]: stateWith('b1') }), {
        rename: async () => {
          throw new Error('rename failed')
        },
      }).store
      await assert.rejects(a.get(STATE_KEY), /rename failed/)
      await assert.rejects(a.set(STATE_KEY, stateWith('s1')), /rename failed/)
      assert.deepEqual(readdirSync(dir), [])
    })

    test('a failed corrupt copy rejects get, latches, and leaves the corrupt state.json as it was', async () => {
      const dir = tempDir()
      writeFileSync(join(dir, 'state.json'), 'not json')
      const s = store(dir, fakeBackup({ [STATE_KEY]: stateWith('b1') }), {
        writeFile: async (path, data, options) => {
          if (path.includes('corrupt-')) throw new Error('copy failed')
          if (!path.includes(`owner.tmp-`)) throw new Error('only the owner and the corrupt copy write here')
          await writeFile(path, data, options)
        },
      })
      await assert.rejects(s.store.get(STATE_KEY), /copy failed/)
      await assert.rejects(s.store.set(STATE_KEY, stateWith('s1')), /copy failed/)
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), 'not json')
      assert.deepEqual(readdirSync(dir).sort(), ['owner', 'state.json'])
      assert.deepEqual(s.lines, [])
    })

    test('a failed owner write rejects get and latches', async () => {
      const dir = tempDir()
      const a = store(dir, fakeBackup({ [STATE_KEY]: stateWith('b1') }), {
        rename: async (from, to) => {
          if (to.endsWith('owner')) throw new Error('owner rename failed')
          await rename(from, to)
        },
      }).store
      await assert.rejects(a.get(STATE_KEY), /owner rename failed/)
      await assert.rejects(a.set(STATE_KEY, stateWith('s1')), /owner rename failed/)
      assert.deepEqual(readdirSync(dir), [])
    })
  })

  describe('the owner check', () => {
    const json = (dir: string) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    const LOST = 'turns: another worker owns the state'

    test('a second store that takes ownership makes the first stop saving', async () => {
      const dir = tempDir()
      const a = store(dir)
      await a.store.get(STATE_KEY)
      await a.store.set(STATE_KEY, stateWith('a1'))
      const b = store(dir).store
      assert.deepEqual(await b.get(STATE_KEY), stateWith('a1'))
      await b.set(STATE_KEY, stateWith('b1'))
      await a.store.set(STATE_KEY, stateWith('a2'))
      await a.store.set(STATE_KEY, stateWith('a3'))
      assert.deepEqual(json(dir), stateWith('b1'))
      assert.deepEqual(a.lines, [LOST])
      const before = readFileSync(join(dir, 'state.json'))
      await a.store.set(STATE_KEY, stateWith('a4'))
      assert.deepEqual(readFileSync(join(dir, 'state.json')), before)
      assert.deepEqual(a.lines, [LOST])
      assert.deepEqual(temps(dir), [])
    })

    test('the owner file has mode 0600', async () => {
      const dir = tempDir()
      await store(dir).store.get(STATE_KEY)
      assert.equal(statSync(join(dir, 'owner')).mode & 0o777, 0o600)
      assert.match(readFileSync(join(dir, 'owner'), 'utf8'), /^[0-9a-f]{32}$/)
    })

    test('a store whose owner file is removed stops saving', async () => {
      const dir = tempDir()
      const a = store(dir)
      await a.store.get(STATE_KEY)
      await a.store.set(STATE_KEY, stateWith('a1'))
      rmSync(join(dir, 'owner'))
      await a.store.set(STATE_KEY, stateWith('a2'))
      assert.deepEqual(json(dir), stateWith('a1'))
      assert.deepEqual(a.lines, [LOST])
      assert.deepEqual(temps(dir), [])
    })

    /** A claims `owner` and pauses; B claims, writes its migration temp file and pauses; A goes on, then B. */
    async function startAtOnce(ageBTemp: boolean) {
      const dir = tempDir()
      const backup = fakeBackup({ [STATE_KEY]: stateWith('key') })
      const gate = () => {
        let open!: () => void
        const p = new Promise<void>(r => (open = r))
        return { p, open }
      }
      const aClaimed = gate(), aGo = gate(), bTemp = gate(), bGo = gate()
      let bTempPath = ''
      const a = store(dir, backup, {
        rename: async (from, to) => {
          await rename(from, to)
          if (to.endsWith('owner')) {
            aClaimed.open()
            await aGo.p
          }
        },
      })
      const b = store(dir, backup, {
        writeFile: async (path, data, options) => {
          await writeFile(path, data, options)
          if (path.includes('state.json.tmp-')) {
            bTempPath = path
            bTemp.open()
            await bGo.p
          }
        },
      })
      const aGet = a.store.get(STATE_KEY)
      await aClaimed.p
      const bGet = b.store.get(STATE_KEY)
      await bTemp.p
      // A write suspended for hours (laptop sleep, clock jump) looks like a crash's leftover by its age.
      if (ageBTemp) utimesSync(bTempPath, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000))
      aGo.open()
      assert.deepEqual(await aGet, stateWith('key'))
      bGo.open()
      assert.deepEqual(await bGet, stateWith('key'))
      assert.deepEqual(json(dir), stateWith('key'))
      await b.store.set(STATE_KEY, stateWith('S'))
      assert.deepEqual(json(dir), stateWith('S'))
      assert.deepEqual(a.lines, [LOST])
      assert.deepEqual(temps(dir), [])
    }

    test("two workers that start at once: the first one's start keeps the owner's migration temp file", () => startAtOnce(false))

    test("two workers that start at once: the owner's migration temp file survives when it is 2 hours old", () => startAtOnce(true))

    test("a corrupt-file race leaves the newer worker's valid state.json", async () => {
      const dir = tempDir()
      writeFileSync(join(dir, 'state.json'), 'not json')
      const backup = fakeBackup({ [STATE_KEY]: stateWith('key') })
      // A reads the corrupt bytes, then waits on the barrier.
      let read!: () => void
      const aRead = new Promise<void>(r => (read = r))
      let release!: () => void
      const barrier = new Promise<void>(r => (release = r))
      let held = false
      const a = store(dir, backup, {
        readFile: async path => {
          const bytes = await readFile(path)
          if (path.endsWith('state.json') && !held) {
            held = true
            read()
            await barrier
          }
          return bytes
        },
      })
      const aGet = a.store.get(STATE_KEY)
      await aRead
      const b = store(dir, backup)
      assert.deepEqual(await b.store.get(STATE_KEY), stateWith('key'))
      await b.store.set(STATE_KEY, stateWith('S'))
      // A's corrupt copy gets its own name: wait for the next millisecond.
      const t = Date.now()
      while (Date.now() === t) await new Promise(r => setTimeout(r, 1))
      release()
      assert.deepEqual(await aGet, stateWith('key'))
      assert.deepEqual(json(dir), stateWith('S'))
      assert.equal(a.lines.length, 2)
      assert.match(a.lines[0]!, /^turns: state\.json is corrupt, copied to state\.json\.corrupt-\d+$/)
      assert.equal(a.lines[1], LOST)
      assert.equal(readdirSync(dir).filter(n => n.startsWith('state.json.corrupt-')).length, 2)
      await a.store.set(STATE_KEY, stateWith('a1'))
      assert.deepEqual(json(dir), stateWith('S'))
      assert.deepEqual(await store(dir, backup).store.get(STATE_KEY), stateWith('S'))
      assert.deepEqual(temps(dir), [])
    })
  })

  describe('a rollback to 0.4.6 and forward again', () => {
    const S = 'sess'
    const LINE = /^turns: the state key changed after migration, copied it again; the old file is (state\.json\.pre-rollback-\d+)$/
    const item = (id: string, from: Item['from'] = 'update'): Item =>
      ({ id, kind: 'task', label: null, ask: `Do ${id}`, options: [], rec: null, helps: [], turn: 1, at: 1, from, path: null })
    const receipt: PressLabel = { state: 'answered', kind: 'handoff', answer: 'Hand off', text: '', at: 2, handoff: { worktree: 'wt', operationId: 'op', outcome: 'started' } }
    /** The key before the rollback: one open item, i1. */
    const seed = (): CurrentState => {
      const s = emptySession(1000)
      return { ...emptyState(), sessions: { [S]: { ...s, ledger: { ...s.ledger, items: [item('i1')] } } } }
    }
    /** 0.4.6's three rows: a record (i2), a close (i1) and a handoff receipt (on i2). */
    const threeRows = (s: CurrentState['sessions'][string]) => ({
      ...s,
      ledger: { ...s.ledger, items: [item('i2', 'record')], closed: [...s.ledger.closed, { id: 'i1', kind: 'task' as const, ask: 'Do i1', outcome: 'done', how: 'done' as const, at: 2, item: item('i1') }] },
      presses: { ...s.presses, i2: receipt },
    })
    const rolledKey = (): CurrentState => ({ ...seed(), sessions: { [S]: threeRows(seed().sessions[S]!) } })
    const hasThreeRows = (state: CurrentState) => {
      const s = state.sessions[S]!
      assert.deepEqual(s.ledger.items.map(i => [i.id, i.from]), [['i2', 'record']])
      assert.deepEqual(s.ledger.closed.map(c => c.id), ['i1'])
      assert.deepEqual(s.presses.i2?.handoff, receipt.handoff)
    }
    const tracker = (storage: Storage, log?: (m: string) => void) =>
      createTracker({ storage, clock: fakeClock(1000).clock, read: async () => null, model: async () => { throw new Error('no model') }, log })
    const files = (dir: string, prefix: string) => readdirSync(dir).filter(n => n.startsWith(prefix))
    const bytes = (dir: string, name: string) => readFileSync(join(dir, name))
    /** 0.4.7 migrates the seed and saves one edit, then 0.4.6 writes rolledKey() to the key. */
    async function rolledBack() {
      const dir = tempDir()
      const backup = fakeBackup({ [STATE_KEY]: seed() })
      const fwd = tracker(store(dir, backup).store)
      await fwd.start()
      await fwd.edit(S, s => ({ ...s, unread: 1 }))
      const earlier = bytes(dir, 'state.json')
      backup.data.set(STATE_KEY, rolledKey())
      return { dir, backup, earlier }
    }

    test("a rollback to 0.4.6 and forward again keeps 0.4.6's record, close and handoff receipt", async () => {
      const dir = tempDir()
      const backup = fakeBackup({ [STATE_KEY]: seed() })
      const fwd = tracker(store(dir, backup).store)
      await fwd.start()
      await fwd.edit(S, s => ({ ...s, unread: 1 }))
      const earlier = bytes(dir, 'state.json')
      // 0.4.6 runs on the key, as it did before the file store.
      const old = tracker(backup)
      await old.start()
      await old.edit(S, threeRows)
      const s = store(dir, backup)
      const back = tracker(s.store)
      await back.start()
      hasThreeRows(back.state())
      const copies = files(dir, 'state.json.pre-rollback-')
      assert.equal(copies.length, 1)
      assert.deepEqual(bytes(dir, copies[0]!), earlier)
      assert.equal(s.lines.length, 1)
      assert.equal(LINE.exec(s.lines[0]!)?.[1], copies[0])
      hasThreeRows(JSON.parse(bytes(dir, 'state.json').toString('utf8')))
    })

    test('a second start after the recopy copies nothing', async () => {
      const { dir, backup } = await rolledBack()
      await store(dir, backup).store.get(STATE_KEY)
      const after = bytes(dir, 'state.json')
      const s = store(dir, backup)
      hasThreeRows((await s.store.get(STATE_KEY)) as CurrentState)
      assert.equal(files(dir, 'state.json.pre-rollback-').length, 1)
      assert.deepEqual(bytes(dir, 'state.json'), after)
      assert.deepEqual(s.lines, [])
    })

    test('a key that was empty at migration and is written by 0.4.6 is copied', async () => {
      const dir = tempDir()
      const backup = fakeBackup()
      const a = store(dir, backup).store
      assert.equal(await a.get(STATE_KEY), null)
      await a.set(STATE_KEY, stateWith('a1'))
      backup.data.set(STATE_KEY, rolledKey())
      hasThreeRows((await store(dir, backup).store.get(STATE_KEY)) as CurrentState)
    })

    test('a newer-version state.json is returned as-is, and it and its sidecar stay unchanged through saves', async () => {
      const dir = tempDir()
      const newer = JSON.stringify({ version: 4, terminals: {}, sessions: {} })
      writeFileSync(join(dir, 'state.json'), newer)
      writeFileSync(join(dir, 'state.json.from'), 'a fingerprint of another key')
      const s = store(dir, fakeBackup({ [STATE_KEY]: rolledKey() }))
      const lines: string[] = []
      const t = tracker(s.store, m => lines.push(m))
      await t.start()
      assert.deepEqual(lines, ['turns: stored state version 4 is newer than this plugin'])
      await t.track('term-1', 'sess-2')
      await t.edit('sess-2', x => ({ ...x, unread: 1 }))
      assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), newer)
      assert.equal(readFileSync(join(dir, 'state.json.from'), 'utf8'), 'a fingerprint of another key')
      assert.deepEqual(files(dir, 'state.json.pre-rollback-'), [])
      assert.deepEqual(s.lines, [])
    })

    test("a first migration stopped between its two writes does not hide 0.4.6's later changes", async () => {
      const dir = tempDir()
      const backup = fakeBackup({ [STATE_KEY]: seed() })
      let renames = 0
      const first = store(dir, backup, {
        rename: async (from, to) => {
          if (!to.endsWith('owner') && ++renames === 2) throw new Error('stopped between the writes')
          await rename(from, to)
        },
      })
      await assert.rejects(first.store.get(STATE_KEY), /stopped between the writes/)
      backup.data.set(STATE_KEY, rolledKey())
      hasThreeRows((await store(dir, backup).store.get(STATE_KEY)) as CurrentState)
    })

    describe('failure paths', () => {
      test('a failed pre-rollback copy leaves state.json and the sidecar as they were', async () => {
        const { dir, backup, earlier } = await rolledBack()
        const from = bytes(dir, 'state.json.from')
        const s = store(dir, backup, {
          writeFile: async (path, data, options) => {
            if (path.includes('pre-rollback-')) throw new Error('copy failed')
            await writeFile(path, data, options)
          },
        })
        await assert.rejects(s.store.get(STATE_KEY), /copy failed/)
        await assert.rejects(s.store.set(STATE_KEY, stateWith('x')), /copy failed/)
        assert.deepEqual(bytes(dir, 'state.json'), earlier)
        assert.deepEqual(bytes(dir, 'state.json.from'), from)
        assert.deepEqual(files(dir, 'state.json.pre-rollback-'), [])
        assert.deepEqual(temps(dir), [])
      })

      test('a failed recopy write leaves state.json as it was and keeps the pre-rollback copy', async () => {
        const { dir, backup, earlier } = await rolledBack()
        const from = bytes(dir, 'state.json.from')
        const s = store(dir, backup, {
          rename: async (from, to) => {
            if (to.endsWith('state.json')) throw new Error('recopy failed')
            await rename(from, to)
          },
        })
        await assert.rejects(s.store.get(STATE_KEY), /recopy failed/)
        await assert.rejects(s.store.set(STATE_KEY, stateWith('x')), /recopy failed/)
        assert.deepEqual(bytes(dir, 'state.json'), earlier)
        assert.deepEqual(bytes(dir, 'state.json.from'), from)
        const copies = files(dir, 'state.json.pre-rollback-')
        assert.equal(copies.length, 1)
        assert.deepEqual(bytes(dir, copies[0]!), earlier)
        assert.deepEqual(temps(dir), [])
      })

      test("a failed sidecar write after the recopy leaves the key's state in state.json, and the next start copies the key again", async () => {
        const { dir, backup } = await rolledBack()
        const from = bytes(dir, 'state.json.from')
        const s = store(dir, backup, {
          rename: async (f, to) => {
            if (to.endsWith('state.json.from')) throw new Error('sidecar failed')
            await rename(f, to)
          },
        })
        await assert.rejects(s.store.get(STATE_KEY), /sidecar failed/)
        await assert.rejects(s.store.set(STATE_KEY, stateWith('x')), /sidecar failed/)
        hasThreeRows(JSON.parse(bytes(dir, 'state.json').toString('utf8')))
        assert.deepEqual(bytes(dir, 'state.json.from'), from)
        assert.deepEqual(temps(dir), [])
        const next = store(dir, backup)
        hasThreeRows((await next.store.get(STATE_KEY)) as CurrentState)
        assert.match(next.lines[0] ?? '', LINE)
        assert.notDeepEqual(bytes(dir, 'state.json.from'), from)
      })

      test('a failed first sidecar write rejects get, latches, and writes no state.json', async () => {
        const dir = tempDir()
        const s = store(dir, fakeBackup({ [STATE_KEY]: seed() }), {
          rename: async (f, to) => {
            if (to.endsWith('state.json.from')) throw new Error('sidecar failed')
            await rename(f, to)
          },
        })
        await assert.rejects(s.store.get(STATE_KEY), /sidecar failed/)
        await assert.rejects(s.store.set(STATE_KEY, stateWith('x')), /sidecar failed/)
        assert.deepEqual(readdirSync(dir), ['owner'])
      })

      test('a failed sidecar write at a start with no sidecar latches and leaves state.json', async () => {
        const dir = tempDir()
        writeFileSync(join(dir, 'state.json'), JSON.stringify(stateWith('s1')))
        const before = bytes(dir, 'state.json')
        const s = store(dir, fakeBackup(), {
          rename: async (f, to) => {
            if (to.endsWith('state.json.from')) throw new Error('sidecar failed')
            await rename(f, to)
          },
        })
        await assert.rejects(s.store.get(STATE_KEY), /sidecar failed/)
        await assert.rejects(s.store.set(STATE_KEY, stateWith('x')), /sidecar failed/)
        assert.deepEqual(bytes(dir, 'state.json'), before)
        assert.deepEqual(readdirSync(dir).sort(), ['owner', 'state.json'])
      })
    })
  })

  test('another key reads and writes the backup', async () => {
    const dir = tempDir()
    const s = store(dir, fakeBackup({ snoozes: { a: 1 } }))
    assert.deepEqual(await s.store.get('snoozes'), { a: 1 })
    await s.store.set('snoozes', { b: 2 })
    assert.deepEqual(s.backup.data.get('snoozes'), { b: 2 })
    assert.equal(s.backup.calls.set, 1)
    assert.deepEqual(readdirSync(dir), [])
  })
})
