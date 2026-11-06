// The conversation formatter used by the copied Codex rollout reader.
import { clip } from './text'

const NL = '\n'
const TRANSCRIPT_MAX = 80_000
const MESSAGE_MAX = 6000

export type Turn = { role: 'person' | 'agent'; text: string; activity: string[]; isVerbatim?: true }

export function flattenConversation(turns: Turn[]): string {
  const lines: string[] = []
  for (const turn of turns) {
    const text = turn.text.trim()
    const shown = turn.isVerbatim ? text : clip(text, MESSAGE_MAX)
    if (turn.role === 'person') {
      if (text && !text.startsWith('inbox:')) lines.push(`Person: ${shown}`)
      continue
    }
    if (text) lines.push(`Agent: ${shown}`)
    for (const line of turn.activity) lines.push(`Agent ${line}`)
  }
  const kept: string[] = []
  let size = 0
  for (const line of lines.reverse()) {
    size += line.length + 1
    if (size > TRANSCRIPT_MAX) {
      kept.push('(earlier conversation left out)')
      break
    }
    kept.push(line)
  }

  return kept.reverse().join(NL)
}
