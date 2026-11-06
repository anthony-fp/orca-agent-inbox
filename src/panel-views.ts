// Inbox views written by hand, for panel.test.tsx and panel.check.ts.
import { choices, fixLabel, FINDING_GROUPS, stepsOf, type ClosedGroup } from './core/now'
import { parsePlan } from './core/plan'
import type { Finding, Help } from './core/types'
import type { LabelledFinding, LabelledFindings, LabelledRow } from './presses'
import type { InboxSection, InboxView } from './protocol'

const NONE: ClosedGroup = { shown: [], total: 0 }
const NO_FINDINGS: LabelledFindings = { issues: [], opportunities: [], closed: { issues: NONE, opportunities: NONE } }

export function section(
  n: number,
  rows: Partial<Pick<InboxSection, 'questions' | 'tasks' | 'closed' | 'findings' | 'plan' | 'planError' | 'tools' | 'agent' | 'trustHook'>> = {},
): InboxSection {
  return {
    terminalId: `terminal-${n}`,
    sessionId: `session-${n}`,
    title: `Agent ${n}`,
    drawn: `drawn-${n}`,
    lastActivity: 1000 - n,
    questions: [],
    tasks: [],
    closed: { questions: NONE, tasks: NONE },
    findings: NO_FINDINGS,
    plan: null,
    planError: null,
    tools: true,
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

/** A finding as the worker sends it. */
export function finding(
  id: string,
  kind: Finding['kind'],
  title: string,
  over: { detail?: string; fileName?: string | null; label?: LabelledFinding['label'] } = {},
): LabelledFinding {
  const { detail = 'Found while working on the task.', fileName = null, label = null } = over
  return { id, kind, mark: FINDING_GROUPS[kind].mark, title, detail, fileName, age: '1h', fix: fixLabel({ kind }), label }
}

export const EMPTY_VIEW: InboxView = { sections: [], others: [], untracked: 0, unread: 0 }

export const ONE_AGENT: InboxView = {
  sections: [
    section(1, {
      questions: [row('q1', 'Rename the folder to tools?', { options: ['Yes', 'No'], handle: '1)' })],
      tasks: [row('t1', 'Run the migration on staging', { age: '5m' })],
    }),
  ],
  others: [],
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
  others: [],
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
  others: [],
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
  others: [],
  untracked: 2,
  unread: 1,
}

/** A task, an issue with a file, and an opportunity; the opportunities have closed ones. */
export const FINDINGS: InboxView = {
  sections: [
    section(1, {
      tasks: [row('t1', 'Run the migration on staging')],
      findings: {
        issues: [
          finding('i4', 'issue', 'The retry loop never backs off', { detail: 'Each retry fires at once, so a down server gets a flood.', fileName: 'fetch.ts' }),
        ],
        opportunities: [finding('i5', 'opportunity', 'Cache the parsed config')],
        closed: {
          issues: NONE,
          opportunities: { shown: [{ id: 'i2', mark: '✕', text: 'Drop the old flag', outcome: 'Dismissed', age: '2h' }], total: 1 },
        },
      },
    }),
  ],
  others: [],
  untracked: 0,
  unread: 0,
}

/** Only closed findings: both groups show, each with its empty line. */
export const CLOSED_FINDINGS: InboxView = {
  sections: [
    section(1, {
      findings: {
        issues: [],
        opportunities: [],
        closed: { issues: { shown: [{ id: 'i1', mark: '✓', text: 'Fix the typo', outcome: 'Fixed in the parser', age: '3h' }], total: 1 }, opportunities: NONE },
      },
    }),
  ],
  others: [],
  untracked: 0,
  unread: 0,
}

const PLAN_TEXT = [
  '## Read the code',
  '- [x] Find the parser',
  '- [x] Read its tests',
  '## Write the fix',
  '- [x] Add a failing test',
  '- [~] Change the parser',
  '- [ ] Run the suite',
  '## Ship it',
  '- [ ] Open the PR',
].join('\n')

/** A plan of three tasks: one done, one with a step in progress, one waiting. */
export const PLAN: InboxView = {
  sections: [section(1, { plan: parsePlan(PLAN_TEXT) })],
  others: [],
  untracked: 0,
  unread: 0,
}

/** A Claude Code agent whose launch got no tools, beside an untracked Codex agent. */
export const MIXED: InboxView = {
  sections: [section(1, { tools: false, questions: [row('q1', 'Keep the cache?', { options: ['Yes', 'No'] })] })],
  others: [{ key: 'terminal-9', title: 'Codex', agent: 'codex' }],
  untracked: 0,
  unread: 0,
}

/** A workspace with only a Codex agent. */
export const CODEX_ONLY: InboxView = { sections: [], others: [{ key: 'terminal-9', title: 'Codex', agent: 'codex' }], untracked: 0, unread: 0 }
