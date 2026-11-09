// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { NowGroups } from './core/now'
import type { PlanView } from './core/plan'
import type { LabelledFindings, LabelledRow, PressInput, PressOutcome } from './presses'

/** One tracked agent in the focused workspace. */
export type InboxSection = {
  terminalId: string
  sessionId: string
  title: string
  /** Codex shares the rows and presses; an absent value is Claude Code. */
  agent?: 'codex'
  /** A Codex launch has not yet delivered a trusted prompt hook. */
  trustHook?: boolean
  /** The row's token when drawn, passed back with each press. */
  drawn: string
  /** The last launch, `done` or press, in ms. Sections come newest first. */
  lastActivity: number
  questions: LabelledRow[]
  tasks: LabelledRow[]
  /** Each group's closed items, newest first, for its "N closed" fold. */
  closed: NowGroups['closed']
  /** Open issues and opportunities, newest first, each with its press label, and their closed lists. */
  findings: LabelledFindings
  /** False when the launch got no inbox tools (plan T11): the section says "No tools". */
  tools: boolean
  /** The session's plan file as parsePlan reads it, or null when there is none or it has no step. */
  plan: PlanView | null
  /** The plan file's path when it exists but cannot be read or has text but no step: the section says so in one line. */
  planError: string | null
}

/** An agent without a tracked section. */
export type OtherAgent = { key: string; title: string; agent?: string; reason?: 'launch-skipped' | 'launch-unmatched' }

/** What a Copy did: the worker wrote the clipboard, or why it could not, so the panel shows the text to select. */
export type CopyOutcome = { ok: true } | { ok: false; error: string }

/** What an Open did: the worker opened the file in Orca's editor, or why it could not. */
export type OpenOutcome = CopyOutcome

export type InboxView = {
  sections: InboxSection[]
  /** Agents without a tracked section, drawn under their own titles. They count in no other field. */
  others: OtherAgent[]
  /** Claude Code agents in the focused workspace the plugin did not see launch. */
  untracked: number
  /** Turns dropped after 3 failed model runs, over the sections shown: "N turns not read". */
  unread: number
}

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace's tracked agents, each with its open rows and press labels. */
    'inbox.view': { output: InboxView }
    /** An option, a typed reply, a step, Fix, File issue, Done or Dismiss on one row. A sent press's label also arrives in the next view. */
    'inbox.press': { input: PressInput; output: PressOutcome }
    /** Writes the text to the clipboard (`pbcopy` on macOS). */
    'inbox.copy': { input: { text: string }; output: CopyOutcome }
    /** Opens a row's file in Orca's editor. The path is as the agent gave it, relative to the session's folder or absolute. */
    'inbox.openFile': { input: { sessionId: string; path: string }; output: OpenOutcome }
  }
  interface PluginPanelEvents {
    /** Posted after each saved change: ask for `inbox.view` again. */
    'inbox.changed': Record<string, never>
  }
}
