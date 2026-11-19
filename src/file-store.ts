// The state in a file, not in one Orca storage value: Orca rejects a value over 262144 bytes (docs/file-store-spec.md).
// Only the state key moves; any other key stays in Orca storage. The first load copies the old key, which then stays as
// a frozen backup. Saves are enabled only after a load that succeeds (spec point 7). The newest worker owns the file:
// a store that finds another id in `owner` stops writing (spec point 4). A key that 0.4.6 changed after the migration is
// copied again (spec point 6).
import { createHash, randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_KEY, newerVersion, upgradeState } from './state'
import type { Storage } from './turns'

const STATE = 'state.json'
const OWNER = 'owner'
/** The fingerprint of the state key the file was last copied from. */
const FROM = `${STATE}.from`

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')

/** The file calls a test can fail or pause. */
export type FileStoreFs = {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string | Buffer, options: { mode: number; flag?: string }): Promise<void>
  rename(from: string, to: string): Promise<void>
}

const realFs: FileStoreFs = {
  readFile: path => fsp.readFile(path),
  writeFile: (path, data, options) => fsp.writeFile(path, data, options),
  rename: (from, to) => fsp.rename(from, to),
}

const code = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code

export function fileStore({ dir, backup, log, fs: override }: { dir: string; backup: Storage; log: (message: string) => void; fs?: Partial<FileStoreFs> }): Storage {
  const fs = { ...realFs, ...override }
  let started: Promise<void> | undefined
  let loaded = false
  let latched: { error: unknown } | null = null
  const id = randomBytes(16).toString('hex')
  let readOnly = false

  /** Makes the 0700 folder and takes ownership. */
  async function start(): Promise<void> {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await fsp.chmod(dir, 0o700)
    await write(OWNER, id)
  }

  /** True while `owner` holds this store's id. A read that fails counts as another owner. */
  async function owns(): Promise<boolean> {
    const text = await fs.readFile(join(dir, OWNER)).then(b => b.toString('utf8'), () => null)
    return text === id
  }

  /**
   * Writes a 0600 temp file, then renames it over `name`. A failure removes the temp file. Any file but `owner` is
   * renamed only while this store owns the state; once it does not, the write resolves and writes nothing.
   */
  async function write(name: string, text: string): Promise<void> {
    if (readOnly) return
    const temp = join(dir, `${name}.tmp-${randomBytes(6).toString('hex')}`)
    try {
      await fs.writeFile(temp, text, { mode: 0o600 })
      if (name !== OWNER && !(await owns())) {
        if (!readOnly) log('turns: another worker owns the state')
        readOnly = true
        await fsp.unlink(temp).catch(() => undefined)
        return
      }
      await fs.rename(temp, join(dir, name))
    } catch (e) {
      await fsp.unlink(temp).catch(() => undefined)
      throw e
    }
  }

  /** The file's value, or the backup key copied to the file when there is no file or it is corrupt. */
  async function load(): Promise<unknown> {
    await (started ??= start())
    let bytes: Buffer | null = null
    try {
      bytes = await fs.readFile(join(dir, STATE))
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e
    }
    if (bytes) {
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch {
        // Copy, never move: state.json may already be a newer worker's valid file. The next save replaces it.
        const name = `${STATE}.corrupt-${Date.now()}`
        await fs.writeFile(join(dir, name), bytes, { mode: 0o600, flag: 'wx' })
        log(`turns: ${STATE} is corrupt, copied to ${name}`)
        return migrate()
      }
      upgradeState(value) // A check only: the tracker logs its own failure and goes on with the empty state.
      // A newer plugin's file: the tracker goes read-only, and this store replaces neither file.
      if (newerVersion(value) !== null) return value
      return recopy(bytes, value)
    }
    return migrate()
  }

  /** The key when 0.4.6 wrote it after the migration (its fingerprint changed), else the file's value. */
  async function recopy(bytes: Buffer, value: unknown): Promise<unknown> {
    const key = await backup.get(STATE_KEY)
    const from = await fs.readFile(join(dir, FROM)).then(b => b.toString('utf8'), e => {
      if (code(e) === 'ENOENT') return null
      throw e
    })
    if (from === fingerprint(key)) return value
    if (from === null) {
      await write(FROM, fingerprint(key))
      log(`turns: ${STATE} had no ${FROM}, wrote the state key's fingerprint`)
      return value
    }
    upgradeState(key)
    const name = `${STATE}.pre-rollback-${Date.now()}`
    await fs.writeFile(join(dir, name), bytes, { mode: 0o600, flag: 'wx' })
    await write(STATE, JSON.stringify(key))
    await write(FROM, fingerprint(key))
    log(`turns: the state key changed after migration, copied it again; the old file is ${name}`)
    return key
  }

  /** Copies the key to the file. The fingerprint goes first: a crash between the two writes then copies the key again. */
  async function migrate(): Promise<unknown> {
    const value = await backup.get(STATE_KEY)
    if (value != null) upgradeState(value)
    await write(FROM, fingerprint(value))
    if (value == null) return null
    await write(STATE, JSON.stringify(value))
    return value
  }

  return {
    async get(key) {
      if (key !== STATE_KEY) return backup.get(key)
      try {
        const value = await load()
        loaded = true
        return value
      } catch (e) {
        latched ??= { error: e }
        throw e
      }
    },
    async set(key, value) {
      if (key !== STATE_KEY) return backup.set(key, value)
      if (latched) throw latched.error
      if (!loaded) throw new Error('turns: the state is not saved before the state loads')
      await write(STATE, JSON.stringify(value))
    },
  }
}
