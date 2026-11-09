/** A session's plan: the outline Claude writes for multi-step work, and what the Now tab reads from it. */

import type { PlanStep, PlanTask, PlanView, StepMark } from './types'
import type { ToneName } from './tones'

// The types live with the saved state, which keeps the last plan read; they are exported here for the hosts.
export type { PlanStep, PlanTask, PlanView, StepMark }

const HEADING = /^#{1,6}\s+(.*)$/
const STEP = /^\s*[-*]\s\[( |~|x|X)\]\s+(.*)$/

const MARKS: Record<string, StepMark> = { ' ': 'waiting', '~': 'current', x: 'done', X: 'done' }

/** Reads a plan file's tasks and steps, or null when it holds no checkbox step. */
export function parsePlan(text: string): PlanView | null {
  const tasks: { title: string; steps: PlanStep[] }[] = []
  let task: { title: string; steps: PlanStep[] } | null = null

  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading) {
      task = { title: heading[1]!.trim(), steps: [] }
      tasks.push(task)
      continue
    }
    const step = STEP.exec(line)
    if (!step) continue
    if (!task) {
      task = { title: '', steps: [] }
      tasks.push(task)
    }
    task.steps.push({ text: step[2]!.trim(), mark: MARKS[step[1]!]! })
  }

  const withSteps = tasks.filter(t => t.steps.length > 0)
  if (withSteps.length === 0) return null
  const steps = withSteps.flatMap(t => t.steps)

  return {
    tasks: withSteps.map(t => ({ ...t, isOpen: t.steps.some(s => s.mark === 'current') })),
    done: steps.filter(s => s.mark === 'done').length,
    total: steps.length,
    current: steps.filter(s => s.mark === 'current'),
  }
}

const GOAL = /^## (.*)$/m

/** The plan's goal line: the text of its first `## ` heading, trimmed, or null when it has none. */
export function planGoal(text: string): string | null {
  return GOAL.exec(text)?.[1]!.trim() || null
}

/** Where a session's plan lives: one file per session, so sessions in one worktree never share a plan. */
export function planPath(worktree: string, sessionId: string): string {
  return `${worktree}/.inbox/plans/${sessionId}.md`
}

/**
 * What Claude reads about its plan, beside each of the person's prompts and after a compaction. Claude Code only:
 * Codex and omp draw no Now tab, so the shared guidance and inbox text say nothing of a plan.
 */
export function planNote(path: string, plan: PlanView | null): string {
  const rule =
    `inbox: your plan file for this session is ${path}. For work of three or more steps, write the plan there before you start:` +
    ' a `## ` heading per task and one line per step, marked `- [ ]` waiting, `- [~]` in progress or `- [x]` done.' +
    ' Mark a step `[~]` when you start it and `[x]` when you finish it, and keep the file current as the work changes.' +
    ' Write no plan for smaller work.'
  if (!plan || plan.current.length === 0) return rule

  return `${rule} In progress now:\n${plan.current.map(s => `- [~] ${s.text}`).join('\n')}`
}

/** One line of the plan section: its text, its look's tone or dim, and how far it sits in. */
export type PlanLine = { text: string; tone: ToneName | 'dim' | null; isBold: boolean; indent: number }

const BAR_CELLS = 20
const STEP_MARKS: Record<StepMark, string> = { done: '✓', current: '◐', waiting: '○' }
const STEP_TONES: Record<StepMark, PlanLine['tone']> = { done: 'done', current: 'needsYou', waiting: null }

/**
 * The Now tab's plan section: the done count and a bar, then each task. A task with a current step lists its steps;
 * every other task takes one line with its count. `error` is the path of a plan file that is there
 * but cannot be read, or that has text and no checkbox step.
 */
export function planLines(view: PlanView | null, error: string | null): PlanLine[] {
  if (error !== null) return [{ text: `Could not read the plan: ${error}`, tone: 'error', isBold: false, indent: 0 }]
  if (!view) return []
  const filled = view.total === 0 ? 0 : Math.round((view.done / view.total) * BAR_CELLS)
  const lines: PlanLine[] = [
    { text: `PLAN  ${view.done} of ${view.total} steps`, tone: null, isBold: true, indent: 0 },
    { text: `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`, tone: 'done', isBold: false, indent: 0 },
  ]
  for (const task of view.tasks) {
    const done = task.steps.filter(s => s.mark === 'done').length
    const count = `${task.title || 'Steps'}  ${done}/${task.steps.length}`
    if (!task.isOpen) {
      const isDone = done === task.steps.length
      lines.push({ text: `${isDone ? '✓' : '▸'} ${count}`, tone: isDone ? 'done' : 'dim', isBold: false, indent: 0 })
      continue
    }
    lines.push({ text: `▾ ${count}`, tone: null, isBold: true, indent: 0 })
    for (const step of task.steps)
      lines.push({
        text: `${STEP_MARKS[step.mark]} ${step.text}`,
        tone: STEP_TONES[step.mark],
        isBold: step.mark === 'current',
        indent: 2,
      })
  }

  return lines
}
