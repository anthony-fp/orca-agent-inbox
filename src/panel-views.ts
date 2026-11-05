// Inbox views written by hand, for panel.test.tsx and panel.check.ts.
import { choices, stepsOf, type ClosedGroup } from './core/now'
import type { Help } from './core/types'
import type { LabelledRow } from './presses'
import type { InboxSection, InboxView } from './protocol'

const NONE: ClosedGroup = { shown: [], total: 0 }

export function section(n: number, rows: Partial<Pick<InboxSection, 'questions' | 'tasks' | 'closed'>> = {}): InboxSection {
  return {
    terminalId: `terminal-${n}`,
    sessionId: `session-${n}`,
    title: `Agent ${n}`,
    drawn: `drawn-${n}`,
    lastActivity: 1000 - n,
    questions: [],
    tasks: [],
    closed: { questions: NONE, tasks: NONE },
    plan: null,
    ...rows,
  }
}

/** A row as the worker sends it, with its option buttons built as the worker builds them. */
export function row(
  id: string,
  text: string,
  over: {
    options?: string[]
    rec?: string | null
    helps?: Help[]
    handle?: string
    age?: string | null
    label?: LabelledRow['label']
  } = {},
): LabelledRow {
  const { options = [], rec = null, helps = [], handle = '', age = '2h', label = null } = over
  return { id, handle, text, age, rec, choices: choices({ options, rec }), steps: stepsOf(helps), label }
}

export const EMPTY_VIEW: InboxView = { sections: [], untracked: 0, unread: 0 }

export const ONE_AGENT: InboxView = {
  sections: [
    section(1, {
      questions: [row('q1', 'Rename the folder to tools?', { options: ['Yes', 'No'], handle: '1)' })],
      tasks: [row('t1', 'Run the migration on staging', { age: '5m' })],
    }),
  ],
  untracked: 0,
  unread: 0,
}

/** One question with a recommended option and more options than the fold limit, and closed items in each group. */
export const MANY_OPTIONS: InboxView = {
  sections: [
    section(1, {
      questions: [
        row('q1', 'Which runtime should the build target?', {
          options: ['Node 20', 'Node 22', 'Bun', 'Deno', 'Workers', 'Lambda'],
          rec: 'Bun',
          handle: '1)',
        }),
      ],
      closed: {
        questions: {
          shown: [
            { id: 'q0', mark: '✓', text: 'Keep the lockfile?', outcome: 'Yes', age: '1h' },
            { id: 'q9', mark: '✕', text: 'Rename the repo?', outcome: 'Dismissed', age: '3h' },
            { id: 'q8', mark: '', text: 'Pin the old parser?', outcome: 'No longer applies', age: '1d' },
          ],
          total: 5,
        },
        tasks: { shown: [{ id: 't0', mark: '✓', text: 'Restart the dev server', outcome: 'Done', age: 'now' }], total: 1 },
      },
    }),
  ],
  untracked: 0,
  unread: 0,
}

const RUN: Help = { kind: 'run', command: 'psql -f checks/friday.sql', name: 'Friday check query' }
const LINK: Help = { kind: 'link', url: 'https://example.com/runbook', name: 'runbook' }
const COPY: Help = { kind: 'copy', text: 'PORT=4000', name: 'env line' }

/** A task and a question with steps: a run step that hands off, a link and a copy that run in the panel. */
export const STEPS: InboxView = {
  sections: [
    section(1, {
      questions: [row('q1', 'Set the dev port?', { options: ['4000', '8080'], helps: [COPY], handle: '1)' })],
      tasks: [row('t1', 'Check the Friday numbers before the release', { helps: [RUN, LINK] })],
    }),
  ],
  untracked: 0,
  unread: 0,
}

export const THREE_AGENTS: InboxView = {
  sections: [
    section(1, {
      questions: [
        row('q1', 'Keep the old config format?', { options: ['Keep it', 'Drop it'], rec: 'Drop it', handle: '1)' }),
        row('q2', 'Which port should the dev server use?', {
          handle: '2)',
          label: { text: 'Waits for the agent', tone: 'muted', copy: 'Re "Which port should the dev server use?": 4000' },
        }),
      ],
    }),
    section(2, {
      tasks: [
        row('t1', 'Review the new parser tests'),
        row('t2', 'Approve the schema change', {
          label: {
            text: 'Not delivered',
            tone: 'danger',
            copy: 'Re the task you left for me, "Approve the schema change": approved',
          },
        }),
      ],
    }),
    section(3, {
      questions: [
        row('q1', 'Split the release into two?', {
          options: ['Yes', 'No'],
          label: { text: '✓ Answered', tone: 'success', copy: null },
        }),
      ],
    }),
  ],
  untracked: 2,
  unread: 1,
}
