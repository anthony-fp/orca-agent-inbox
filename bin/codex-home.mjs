// A Codex MCP server receives ORCA_PANE_KEY, but CODEX_HOME is not in its configured env_vars.
// Codex keeps the active rollout open in its parent process (docs/codex-probes.md, probe 5).
import { spawnSync } from 'node:child_process'

/** The account home from a rollout path for this thread, or empty when it is not that rollout. */
export function homeFromRollout(path, threadId) {
  if (typeof path !== 'string' || !threadId || threadId.includes('/')) return ''
  const match = /^(.*)\/sessions\/\d{4}\/\d{2}\/\d{2}\/(rollout-[^/]+\.jsonl)$/.exec(path)
  return match?.[2].endsWith(`-${threadId}.jsonl`) ? match[1] : ''
}

/** Bounded parent-process lookup; a missing path leaves the first tool call usable. */
export function homeFromParent(threadId, run = spawnSync) {
  if (!threadId) return ''
  let result
  try { result = run('lsof', ['-Fn', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 }) }
  catch { return '' }
  if (result.status !== 0 || typeof result.stdout !== 'string') return ''
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('n')) continue
    const home = homeFromRollout(line.slice(1), threadId)
    if (home) return home
  }
  return ''
}
