// Runs the `orca` CLI from the worker: the plugin API has no call that creates a worktree.
// The binary lookup and the run are adapted from felix-lj-ct/orca-agent-inbox (src/worker.ts, orcaCli, searchPath
// and run), MIT, Copyright (c) 2026 Felix Li
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** A hand-off waits this long for Orca to make the worktree and start the agent. */
export const ORCA_TIMEOUT_MS = 60_000

const ORCA_APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export type OrcaExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: true; env: NodeJS.ProcessEnv },
  done: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown

export type OrcaEnv = { platform: string; env: NodeJS.ProcessEnv; execPath: string; exists(path: string): boolean }

/**
 * What a run gave. `error`: Orca answered that it did nothing. `uncertain`: no answer, or one that says the launch may
 * have started, so the caller must not run it again by itself.
 */
export type OrcaReply =
  | { kind: 'ok'; result: any }
  | { kind: 'error'; error: string }
  | { kind: 'uncertain'; error: string; operationId: string | null }

const LOCAL: OrcaEnv = { platform: process.platform, env: process.env, execPath: process.execPath, exists: existsSync }

/** The worker does not get a login shell's PATH. On Windows it gets the one Orca has. */
function searchPath({ platform, env }: OrcaEnv): string {
  const dirs = platform === 'win32' ? [env.PATH] : [env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
  return dirs.filter(Boolean).join(delimiter)
}

/** The orca CLI: Orca's CLI folder, else the one of the running Orca (this worker runs on its runtime), else the first on PATH. */
export function orcaBinary(at: OrcaEnv = LOCAL): string {
  const windows = at.platform === 'win32'
  const name = windows ? 'orca.exe' : 'orca'
  const runtimeDir = dirname(at.execPath)
  const candidates = [
    at.env.ORCA_CLI_BIN_DIR && join(at.env.ORCA_CLI_BIN_DIR, name),
    windows && join(runtimeDir, 'resources', 'bin', name),
    at.platform === 'darwin' && join(runtimeDir, '..', 'Resources', 'bin', name),
    ORCA_APP_CLI,
    ...searchPath(at).split(delimiter).map(dir => join(dir, name)),
  ]
  return candidates.find((path): path is string => typeof path === 'string' && at.exists(path)) ?? name
}

/** The reply's operation id, when Orca gave one. */
const operationOf = (data: any): string | null => (typeof data?.operationId === 'string' ? data.operationId : null)

/** Reads Orca's `{ok, result, error}` JSON. An error that names a launch may have started it. */
export function readReply(stdout: string): OrcaReply | null {
  let out: any
  try {
    out = JSON.parse(stdout)
  } catch {
    return null
  }
  if (out?.ok === true) return { kind: 'ok', result: out.result }
  if (out?.ok !== false) return null
  const error = typeof out.error?.message === 'string' ? out.error.message : 'orca failed'
  const data = out.error?.data
  if (out.error?.code === 'agent_session_operation_unknown' || data?.launchOutcome !== undefined || operationOf(data) !== null)
    return { kind: 'uncertain', error, operationId: operationOf(data) }
  return { kind: 'error', error }
}

/** Runs `orca <args> --json` with a 60 s timeout. It never throws. */
export function runOrca(
  args: string[],
  { execFile = nodeExecFile as unknown as OrcaExecFile, at = LOCAL }: { execFile?: OrcaExecFile; at?: OrcaEnv } = {},
): Promise<OrcaReply> {
  return new Promise(resolve => {
    const options = { timeout: ORCA_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true as const, env: { ...at.env, PATH: searchPath(at) } }
    try {
      execFile(orcaBinary(at), [...args, '--json'], options, (error, stdout, stderr) => {
        // No binary: nothing ran.
        if (error?.code === 'ENOENT') return resolve({ kind: 'error', error: 'The orca CLI was not found' })
        const reply = readReply(String(stdout))
        if (reply) return resolve(reply)
        // A timeout, a crash or text that is not Orca's JSON: the CLI may have done its work.
        const why = error?.killed ? 'no answer in 60 s' : String(stderr).trim() || error?.message || 'no answer'
        resolve({ kind: 'uncertain', error: why, operationId: null })
      })
    } catch (e) {
      resolve({ kind: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** What `worktree create --agent --prompt` did, from its `result`. */
export type Launch = { worktree: string | null; operationId: string | null; started: boolean }

/**
 * The agent started only when Orca gives its handle and the prompt delivered: `prompt.outcome` is `handed-to-terminal`
 * or `journaled`, as Orca's own hand-off guide reads it. An older Orca gives no `launch`, so the start is not shown.
 */
export function launchOf(result: any): Launch {
  const worktree = result?.worktree
  const name = typeof worktree?.displayName === 'string' && worktree.displayName ? worktree.displayName : null
  const launch = result?.launch
  const handle = launch?.outcome?.handle
  const delivered = launch?.prompt?.outcome === 'handed-to-terminal' || launch?.prompt?.outcome === 'journaled'
  return {
    worktree: worktree ? (name ?? (typeof worktree.path === 'string' ? worktree.path : null)) : null,
    operationId: typeof launch?.operationId === 'string' ? launch.operationId : null,
    started: typeof handle === 'string' && handle !== '' && delivered,
  }
}
