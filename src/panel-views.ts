// Inbox views written by hand, for panel.test.tsx and panel.check.ts.
import type { InboxSection, InboxView } from './protocol'

export function section(n: number, rows: Partial<Pick<InboxSection, 'questions' | 'tasks'>> = {}): InboxSection {
  return {
    terminalId: `terminal-${n}`,
    sessionId: `session-${n}`,
    title: `Agent ${n}`,
    drawn: `drawn-${n}`,
    lastActivity: 1000 - n,
    questions: [],
    tasks: [],
    ...rows,
  }
}

export const EMPTY_VIEW: InboxView = { sections: [], untracked: 0, unread: 0 }

export const ONE_AGENT: InboxView = {
  sections: [
    section(1, {
      questions: [{ id: 'q1', text: 'Rename the folder to tools?', options: ['Yes', 'No'], label: null }],
      tasks: [{ id: 't1', text: 'Run the migration on staging', options: [], label: null }],
    }),
  ],
  untracked: 0,
  unread: 0,
}

export const THREE_AGENTS: InboxView = {
  sections: [
    section(1, {
      questions: [
        { id: 'q1', text: 'Keep the old config format?', options: ['Keep it', 'Drop it'], label: null },
        {
          id: 'q2',
          text: 'Which port should the dev server use?',
          options: [],
          label: { text: 'Waits for the agent', tone: 'muted', copy: 'Re "Which port should the dev server use?": 4000' },
        },
      ],
    }),
    section(2, {
      tasks: [
        { id: 't1', text: 'Review the new parser tests', options: [], label: null },
        {
          id: 't2',
          text: 'Approve the schema change',
          options: [],
          label: { text: 'Not delivered', tone: 'danger', copy: 'Re "Approve the schema change": approved' },
        },
      ],
    }),
    section(3, {
      questions: [
        {
          id: 'q1',
          text: 'Split the release into two?',
          options: ['Yes', 'No'],
          label: { text: '✓ Answered', tone: 'success', copy: null },
        },
      ],
    }),
  ],
  untracked: 2,
  unread: 1,
}
