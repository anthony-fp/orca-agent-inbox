// The types the copied ledger, model-text, tools and plan code uses, from the inbox repo's types/index.d.ts, unchanged.

export type Card = {
  goal: string
  done: string[]
  now: string
  running: string[]
}

export type Item = {
  id: string
  kind: 'question' | 'task'
  /** The agent's own number or id for it ("1", "D3"), so "1. yes" maps back. */
  label: string | null
  ask: string
  options: string[]
  /** The option the agent recommended, exactly as `options` has it. */
  rec: string | null
  helps: Help[]
  /** The person-prompt count when the agent asked it. */
  turn: number
  /** When the agent asked it; null for an item saved before the mod kept the time. */
  at: number | null
  /**
   * What added it: the agent's record tool, or a NEW or TODO line of the per-reply update. An item saved before the
   * mod kept this reads as 'update'.
   */
  from: 'record' | 'update'
}

/**
 * A one-press step toward finishing an item. The mod never runs a command:
 * `run` asks Claude to run it, under the usual permission checks, and
 * `terminal` copies one that only the person can run.
 */
export type Help =
  | { kind: 'open'; path: string }
  | { kind: 'copy'; text: string; name: string | null }
  | { kind: 'run'; command: string; name: string | null }
  | { kind: 'terminal'; command: string; name: string | null }
  | { kind: 'link'; url: string; name: string | null }

export type Closed = {
  id: string
  kind: Item['kind']
  ask: string
  label?: string
  outcome: string
  /**
   * How it closed: the person answered it, marked a task done or ran its
   * command, or dismissed it; it expired unanswered; Claude closed it with a
   * reason; or the per-reply update closed it, with an outcome the model wrote.
   */
  how: 'answered' | 'done' | 'dismissed' | 'expired' | 'claude' | 'update'
  at: number
  /** The item as it was while open, so it can be reopened; missing on a record saved before the mod kept it. */
  item?: Item
  /** A Done notification that may have reached the agent, so Undo cannot retract it. */
  isSentToAgent?: true
  doneNotification?: { id: string; error?: string }
}

export type Finding = {
  id: string
  kind: 'issue' | 'opportunity'
  title: string
  detail: string
  /** The file it is about, as Claude gave it. */
  path: string | null
  at: number
  /** The item that replaced this finding by asking about it. A finding closed as "asked as iN" reopens when that item closes with the work undone. */
  askedAs?: string
}

export type ClosedFinding = Finding & Pick<Closed, 'how' | 'outcome'> & { closedAt: number }

export type Ledger = {
  card: Card | null
  items: Item[]
  closed: Closed[]
  findings: Finding[]
  /** Findings that closed, oldest first. Kept apart from `closed`, which the model-read texts list. */
  closedFindings: ClosedFinding[]
  /** PRs this session created or linked, as "owner/repo#123". */
  prs: string[]
  nextId: number
  /** How many prompts the person has sent this session. */
  turn: number
  /** The turn whose reply added the newest items; 0 when none. */
  batchTurn: number
}


export type Exchange = {
  /** What the person typed; null when something else started the turn. */
  person: string | null
  trigger: string | null
  activity: string[]
  reply: string
  /** The person-prompt count when the reply was written. */
  turn: number
  press: Press | null
  screen: string
}

export type Press = { id: string; action: 'answer' | 'explain' | 'run' | 'done' }

/** The inbox text the agent last read beside a prompt, and the closed items it was told about. */
export type Told = { inbox: string | null; closed: string[] }

export type StepMark = 'waiting' | 'current' | 'done'

export type PlanStep = { text: string; mark: StepMark }

/** A heading and its steps. A task is open while one of its steps is current. */
export type PlanTask = { title: string; steps: PlanStep[]; isOpen: boolean }

/** A session's plan, as `parsePlan` in `hooks/plan.ts` reads it. */
export type PlanView = { tasks: PlanTask[]; done: number; total: number; current: PlanStep[] }
