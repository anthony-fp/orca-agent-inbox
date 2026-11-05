// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { NowGroups } from './core/now'
import type { LabelledRow, PressInput, PressOutcome } from './presses'

/** One tracked agent in the focused workspace. */
export type InboxSection = {
  terminalId: string
  sessionId: string
  title: string
  /** Pass back with each press: the press is held when a turn ended since. */
  drawn: string
  /** The last launch, `done` or press, in ms. Sections come newest first. */
  lastActivity: number
  questions: LabelledRow[]
  tasks: LabelledRow[]
  /** Each group's closed items, newest first, for its "N closed" fold. */
  closed: NowGroups['closed']
}

export type InboxView = {
  sections: InboxSection[]
  /** Agents in the focused workspace the plugin did not see launch. */
  untracked: number
  /** Turns dropped after 3 failed model runs, over the sections shown: "N turns not read". */
  unread: number
}

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace's tracked agents, each with its open rows and press labels. */
    'inbox.view': { output: InboxView }
    /** An option, a typed reply, Done or Dismiss on one row. A sent reply's label also arrives in the next view. */
    'inbox.press': { input: PressInput; output: PressOutcome }
  }
  interface PluginPanelEvents {
    /** Posted after each saved change: ask for `inbox.view` again. */
    'inbox.changed': Record<string, never>
  }
}
