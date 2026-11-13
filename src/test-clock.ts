// A fake clock for tests: time moves only when run() passes it to the next timer.
import type { Clock } from './turns'

export function fakeClock(start = 0) {
  let t = start
  const timers: { at: number; wake: () => void }[] = []
  const clock: Clock = {
    now: () => t,
    sleep: ms => new Promise(wake => timers.push({ at: t + ms, wake })),
  }
  /** Runs every task and timer up to `until`, as time passes. */
  async function run(until = Infinity): Promise<void> {
    for (;;) {
      for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r))
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) {
        if (until !== Infinity) t = Math.max(t, until)
        return
      }
      timers.shift()
      t = next.at
      next.wake()
    }
  }
  return { clock, run, now: () => t }
}

/** Storage that rejects a value over `limit` bytes, as Orca's storage does. */
export function rejectingStorage(limit: number, initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(structuredClone(initial)))
  return {
    async get(key: string): Promise<unknown> {
      return structuredClone(data.get(key) ?? null)
    },
    async set(key: string, value: unknown): Promise<void> {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (bytes > limit) throw new Error(`value exceeds ${limit} bytes`)
      data.set(key, structuredClone(value))
    },
    saved: (key: string) => data.get(key),
  }
}
