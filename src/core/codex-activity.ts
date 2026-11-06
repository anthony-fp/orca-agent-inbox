// The two helpers the copied Codex rollout reader uses from its source core.
import { toolActivity } from './model-text'

export function activityOf(tool: string, input: Record<string, unknown>): string | null {
  return toolActivity(tool, input)
}

export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map(m => (m[1] ?? '').trim())
    .filter(Boolean)
}
