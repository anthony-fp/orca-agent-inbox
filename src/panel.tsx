// The inbox panel (spec steps 5 and 6, plans T6 and T12): one section per tracked agent in the focused workspace,
// newest activity first, each with its questions, tasks, findings and plan as in the inbox's Now tab, then a short
// section for each agent that is not Claude Code.
// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  on,
  plugin,
  Progress,
  read,
  Row,
  Separator,
  shell,
  Stack,
  Text,
  update,
} from 'orca'
import { rowCopyText, type ClosedGroup, type CopySource, type Step } from './core/now'
import { planLines, type PlanLine } from './core/plan'
import type { CopyOutcome, InboxSection, InboxView, OtherAgent } from './protocol'
import type { LabelledFinding, LabelledRow, PressInput, RowLabel } from './presses'

type Loaded = { is: 'loading' } | { is: 'error'; message: string } | { is: 'ready'; view: InboxView }

/** The label a press set on its row. `pending` while the press is out. */
type Local = { label: RowLabel; pending: boolean }

const loaded = atom<Loaded>({ is: 'loading' })
/** Each map is keyed by `rowKey`. */
const local = atom<Record<string, Local>>({})
const drafts = atom<Record<string, string>>({})
/** Rows whose Copy text shows. */
const shown = atom<Record<string, boolean>>({})
/** Rows whose reply field is open. */
const replying = atom<Record<string, boolean>>({})
/** Questions whose folded options show. */
const allShown = atom<Record<string, boolean>>({})
/** What a row's last local step did: opened a link, copied, or shows text to copy. */
const stepResults = atom<Record<string, RowLabel>>({})
/** What a label's Copy press did, by label: under way, done, or failed, so the label shows its text to select. */
const copies = atom<Record<string, 'copying' | 'copied' | 'failed'>>({})
/** Plan tasks the person opened or closed, by `planKey`. Kept while the panel runs; a task not here takes its default. */
const planOpen = atom<Record<string, boolean>>({})
/** Whether each session's completed plan tasks are visible. */
const completedPlansOpen = atom<Record<string, boolean>>({})

/** What a row reads while its press is out. Done and Dismiss read as the row closing, as the inbox's Mark presses do. */
const SENDING: RowLabel = { text: 'Sending…', tone: 'muted', copy: null }
const PENDING: Record<PressInput['action'], RowLabel> = {
  answer: SENDING,
  reply: SENDING,
  step: SENDING,
  fix: SENDING,
  issue: SENDING,
  explain: { text: 'Explaining…', tone: 'muted', copy: null },
  done: { text: '✓ Done', tone: 'muted', copy: null },
  dismiss: { text: 'Dismissed', tone: 'muted', copy: null },
}

const REFUSED: Record<'closed' | 'invalid', RowLabel> = {
  closed: { text: 'Closed already', tone: 'muted', copy: null },
  invalid: { text: 'Not sent', tone: 'danger', copy: null },
}

const rowKey = (s: InboxSection, id: string) => `${s.sessionId}:${id}`
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function load(): Promise<void> {
  try {
    const view = await plugin.request('inbox.view')
    update(loaded, () => ({ is: 'ready', view }))
  } catch (e) {
    update(loaded, () => ({ is: 'error', message: message(e) }))
  }
}

type PressWhat = Pick<PressInput, 'action' | 'answer' | 'step'>
/** What a press needs of a row: an open question, task or finding. */
type Pressable = { id: string; label: RowLabel | null }

async function press(s: InboxSection, row: Pressable, what: PressWhat): Promise<void> {
  const key = rowKey(s, row.id)
  const { action } = what
  update(local, m => ({ ...m, [key]: { label: PENDING[action], pending: true } }))
  const input: PressInput = { terminalId: s.terminalId, sessionId: s.sessionId, drawn: s.drawn, id: row.id, ...what }
  let label: RowLabel
  try {
    const out = await plugin.request('inbox.press', input)
    label = out.ok ? (out.label ?? PENDING[action]) : REFUSED[out.refused]
    if (s.trustHook && out.ok && out.label?.copy) {
      const error = await copyText(out.label.copy)
      label = error ? { text: `Could not copy: ${error}`, tone: 'danger', copy: out.label.copy } : { text: '✓ Copied', tone: 'success', copy: null }
    }
    if (out.ok && action === 'reply') {
      update(drafts, m => ({ ...m, [key]: '' }))
      update(replying, m => ({ ...m, [key]: false }))
    }
  } catch (e) {
    label = { text: `Not sent: ${message(e)}`, tone: 'danger', copy: null }
  }
  update(local, m => ({ ...m, [key]: { label, pending: false } }))
  await load()
}

/** `clipLabel` in the inbox repo's `hooks/presses.ts`. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

/** Asks the worker to write the clipboard. Null when it did, else why not. */
async function copyText(text: string): Promise<string | null> {
  try {
    const out: CopyOutcome = await plugin.request('inbox.copy', { text })
    return out.ok ? null : out.error
  } catch (e) {
    return message(e)
  }
}

/**
 * A local step, as the inbox's `stepEffects` does it where Orca allows: a link opens in the browser, and the worker
 * copies a snippet, a command or a path (Orca cannot open a local file from a panel). Where the copy fails, the text
 * shows to select.
 */
async function localStep(s: InboxSection, row: LabelledRow, step: Step): Promise<void> {
  const key = rowKey(s, row.id)
  const texts = step.helps.flatMap(h => (h.kind === 'copy' ? [h.text] : h.kind === 'terminal' ? [h.command] : h.kind === 'open' ? [h.path] : []))
  if (texts.length > 0) update(stepResults, m => ({ ...m, [key]: { text: 'Copying…', tone: 'muted', copy: null } }))
  const isCopied = texts.length > 0 && (await copyText(texts.join('\n'))) === null
  const parts: string[] = []
  const copies: string[] = []
  let failed = false
  let isOpen = false
  for (const h of step.helps) {
    if (h.kind === 'link') {
      const name = h.name ?? h.url
      const why = /^https:\/\//.test(h.url)
        ? await shell.openExternal(h.url).then(
            (r: { opened: boolean }) => (r.opened ? null : 'cancelled'),
            (e: unknown) => message(e),
          )
        : 'only https links open'
      if (why !== null) failed = true
      parts.push(why === null ? `Opened ${name}` : `Could not open ${name}: ${why}`)
    } else if (h.kind === 'copy') {
      const name = h.name ?? 'snippet'
      if (!isCopied) copies.push(h.text)
      parts.push(isCopied ? `Copied ${name}` : `Select ${name} below to copy it`)
    } else if (h.kind === 'terminal') {
      const name = h.name ?? clip(h.command, 32)
      if (!isCopied) copies.push(h.command)
      parts.push(isCopied ? `Copied ${name}. Run it in Terminal.` : `Select ${name} below to copy it, then run it in Terminal`)
    } else if (h.kind === 'open') {
      isOpen = true
      if (!isCopied) copies.push(h.path)
      parts.push(
        isCopied
          ? `Copied the path of ${baseName(h.path)}: Orca cannot open it from a panel`
          : `Orca cannot open ${baseName(h.path)} from a panel: select its path below to copy it`,
      )
    }
  }
  const isDone = copies.length === 0 && !failed && !isOpen
  const label: RowLabel = {
    text: `${isDone ? '✓ ' : ''}${parts.join(' · ')}`,
    tone: failed ? 'danger' : isDone ? 'success' : 'muted',
    copy: copies.length > 0 ? copies.join('\n') : null,
  }
  update(stepResults, m => ({ ...m, [key]: label }))
  if (label.copy !== null) update(shown, m => ({ ...m, [`step:${key}`]: true }))
}

/**
 * A row's Copy: the worker writes the row's text to the clipboard (`rowCopyText`), and the row reads "✓ Copied", or
 * in red why it could not, with the text to select.
 */
async function copyRow(s: InboxSection, row: Pressable, source: CopySource): Promise<void> {
  const key = rowKey(s, row.id)
  const text = rowCopyText(source)
  update(stepResults, m => ({ ...m, [key]: { text: 'Copying…', tone: 'muted', copy: null } }))
  const error = await copyText(text)
  const label: RowLabel = error === null ? { text: '✓ Copied', tone: 'success', copy: null } : { text: `Could not copy: ${error}`, tone: 'danger', copy: text }
  update(stepResults, m => ({ ...m, [key]: label }))
  if (error !== null) update(shown, m => ({ ...m, [`step:${key}`]: true }))
}

/** Copy on any row, after Explain (and Open, when a row has it) and before Hand off, Snooze and Dismiss. */
function CopyButton({ section, row, source, busy }: { section: InboxSection; row: Pressable; source: CopySource; busy: boolean }) {
  return (
    <Button size="sm" variant="outline" disabled={busy} onPress={() => copyRow(section, row, source)}>
      Copy
    </Button>
  )
}

/** A row's step buttons: a run step goes to the agent through the send check; any other step runs here. */
function StepButtons({ section, row, busy }: { section: InboxSection; row: LabelledRow; busy: boolean }) {
  return (
    <>
      {row.steps.map((step, index) => (
        <Button
          key={`step-${index}`}
          size="sm"
          variant="outline"
          disabled={busy}
          onPress={() =>
            step.kind === 'handoff'
              ? press(section, row, { action: 'step', step: { index, label: step.label } })
              : localStep(section, row, step)
          }
        >
          {section.trustHook && step.kind === 'handoff' ? `Copy ${step.label}` : step.label}
        </Button>
      ))}
    </>
  )
}

/** A row's labels: its last local step's result, then its press label. */
function Labels({ rowKey: key, label }: { rowKey: string; label: RowLabel | null }) {
  const step = read(stepResults)[key]
  return (
    <>
      {step && <Label label={step} rowId={`step:${key}`} />}
      {label !== null && <Label label={label} rowId={key} />}
    </>
  )
}

export function setup(ctx: { subscriptions: { dispose(): void }[] }) {
  ctx.subscriptions.push(plugin.on('inbox.changed', () => void load()))
  // A focus change saves nothing in the worker, so the panel hears it from Orca. A panel needs no manifest entry.
  ctx.subscriptions.push(on('workspace.changed', () => void load()))
  void load()
}

/** Copy writes the clipboard through the worker and reads "✓ Copied". Where that fails, the text shows to select. */
async function copyLabel(rowId: string, text: string): Promise<void> {
  update(copies, m => ({ ...m, [rowId]: 'copying' }))
  const error = await copyText(text)
  update(copies, m => ({ ...m, [rowId]: error === null ? 'copied' : 'failed' }))
  if (error !== null) update(shown, m => ({ ...m, [rowId]: true }))
}

function Label({ label, rowId }: { label: RowLabel; rowId: string }) {
  const isShown = read(shown)[rowId] === true
  const copy = read(copies)[rowId]
  const text = label.copy
  return (
    <Stack gap="xs">
      <Row gap="sm" align="center" wrap>
        <Text size="sm" muted={label.tone === 'muted'} tone={label.tone === 'muted' ? undefined : label.tone}>
          {label.text}
        </Text>
        {text !== null && (
          <Button
            size="xs"
            variant="ghost"
            disabled={copy === 'copying'}
            onPress={() => (isShown ? update(shown, m => ({ ...m, [rowId]: false })) : copyLabel(rowId, text))}
          >
            {isShown ? 'Hide' : 'Copy'}
          </Button>
        )}
        {text !== null && copy === 'copying' && (
          <Text size="sm" muted>
            Copying…
          </Text>
        )}
        {text !== null && copy === 'copied' && (
          <Text size="sm" tone="success">
            ✓ Copied
          </Text>
        )}
      </Row>
      {text !== null && isShown && (
        <CodeView code={text} label={copy === 'failed' ? 'Could not copy: select the text to copy it' : 'Select the text to copy it'} wrap />
      )}
    </Stack>
  )
}

function rowState(section: InboxSection, row: Pressable) {
  const key = rowKey(section, row.id)
  const mine = read(local)[key]
  // A press still out shows its own label. After it, the worker's label wins: it moves on from Sending….
  // A refusal has no worker label, so it stays.
  const busy = mine?.pending === true
  return { key, label: mine && busy ? mine.label : (row.label ?? mine?.label ?? null), busy }
}

/** The reply field a Reply press opens, with Send and Cancel (`ROW_COPY` in the inbox repo's `hooks/view.ts`). */
function ReplyField({ section, row, hint, busy }: { section: InboxSection; row: Pressable; hint: string; busy: boolean }) {
  const key = rowKey(section, row.id)
  const draft = read(drafts)[key] ?? ''
  // Typed words never close the row at once: the inbox model reads the turn and decides (`hooks/presses.ts`, `type`).
  const send = () => {
    if (draft.trim()) void press(section, row, { action: 'reply', answer: draft })
  }
  return (
    <Stack gap="xs">
      <Input
        label={hint}
        labelHidden
        placeholder={hint}
        value={draft}
        disabled={busy}
        onChange={(v: string) => update(drafts, m => ({ ...m, [key]: v }))}
        onSubmit={send}
      />
      <Row gap="xs" wrap>
        <Button size="sm" variant="outline" disabled={busy || !draft.trim()} onPress={send}>
          {section.trustHook ? 'Copy' : 'Send'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => update(replying, m => ({ ...m, [key]: false }))}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

/**
 * The row's text, with the question's number before it and the age on the right, as the inbox draws a row. Each age
 * sits in a Box that does not shrink, so a narrow panel wraps the text beside it and never the age.
 */
function RowHead({ row }: { row: LabelledRow }) {
  return (
    <Row gap="sm" align="start" justify="between">
      <Text>{row.handle ? `${row.handle} ${row.text}` : row.text}</Text>
      {row.age !== null && (
        <Box shrink={false}>
          <Text size="sm" muted>
            {row.age}
          </Text>
        </Box>
      )}
    </Row>
  )
}

/**
 * A question, with buttons in the inbox's order (`rowActions` and `rowKeyPlan` in `hooks/view.ts`): each option, the
 * recommended one first; "All N options" after the fourth when there are more than five; its steps; then Reply,
 * Explain, Copy and Dismiss.
 */
function Question({ section, row }: { section: InboxSection; row: LabelledRow }) {
  const { key, label, busy } = rowState(section, row)
  const isAllShown = read(allShown)[key] === true
  const shownChoices = row.choices.filter(c => isAllShown || !c.isFolded)
  const folded = row.choices.length - shownChoices.length
  return (
    <Stack gap="xs">
      <RowHead row={row} />
      <Row gap="xs" wrap>
        {shownChoices.map(c => (
          <Button
            key={c.option}
            size="sm"
            variant={c.isRec ? 'solid' : 'outline'}
            disabled={busy}
            onPress={() => press(section, row, { action: 'answer', answer: c.option })}
          >
            {section.trustHook ? `Copy ${c.label}` : c.isRec ? `${c.label} (recommended)` : c.label}
          </Button>
        ))}
        {folded > 0 && (
          <Button size="sm" variant="ghost" onPress={() => update(allShown, m => ({ ...m, [key]: true }))}>
            {`All ${row.choices.length} options`}
          </Button>
        )}
        <StepButtons section={section} row={row} busy={busy} />
        <Button size="sm" variant="outline" disabled={busy} onPress={() => update(replying, m => ({ ...m, [key]: true }))}>
          Reply
        </Button>
        <ExplainButton section={section} row={row} busy={busy} />
        <CopyButton section={section} row={row} source={{ kind: 'question', title: row.text }} busy={busy} />
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => press(section, row, { action: 'dismiss' })}>
          Dismiss
        </Button>
      </Row>
      {read(replying)[key] === true && <ReplyField section={section} row={row} hint="Your answer" busy={busy} />}
      <Labels rowKey={key} label={label} />
    </Stack>
  )
}

/** Explain on any row. It reads "Explain again" once the row's last press was Explain. */
function ExplainButton({ section, row, busy }: { section: InboxSection; row: LabelledRow | LabelledFinding; busy: boolean }) {
  return (
    <Button size="sm" variant="outline" disabled={busy} onPress={() => press(section, row, { action: 'explain' })}>
      {section.trustHook ? 'Copy explain request' : row.explained ? 'Explain again' : 'Explain'}
    </Button>
  )
}

/** A task: its whole text with its age, then its steps, Done, Reply (`rowActions` in `hooks/view.ts`), Explain and Copy. */
function Task({ section, row }: { section: InboxSection; row: LabelledRow }) {
  const { key, label, busy } = rowState(section, row)
  return (
    <Stack gap="xs">
      <RowHead row={row} />
      <Row gap="xs" wrap>
        <StepButtons section={section} row={row} busy={busy} />
        <Button size="sm" variant="solid" disabled={busy} onPress={() => press(section, row, { action: 'done' })}>
          Done
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => update(replying, m => ({ ...m, [key]: true }))}>
          Reply
        </Button>
        <ExplainButton section={section} row={row} busy={busy} />
        <CopyButton section={section} row={row} source={{ kind: 'task', title: row.text, steps: row.steps }} busy={busy} />
      </Row>
      {read(replying)[key] === true && (
        <ReplyField section={section} row={row} hint={`Your reply to ${section.agent === 'codex' ? 'Codex' : 'Claude'}`} busy={busy} />
      )}
      <Labels rowKey={key} label={label} />
    </Stack>
  )
}

/** A group's closed items under a folded "N closed" line, newest first, as the inbox's closed list shows them. */
function ClosedFold({ group }: { group: ClosedGroup }) {
  if (group.total === 0) return null
  const earlier = group.total - group.shown.length
  return (
    <Collapsible title={`${group.total} closed`}>
      <Stack gap="sm">
        {group.shown.map(c => (
          <Stack key={c.id} gap="none">
            <Row gap="sm" align="start" justify="between">
              <Text size="sm" muted>
                {c.mark ? `${c.mark} ${c.text}` : c.text}
              </Text>
              <Box shrink={false}>
                <Text size="sm" muted>
                  {c.age}
                </Text>
              </Box>
            </Row>
            <Text size="xs" muted>
              {c.outcome}
            </Text>
          </Stack>
        ))}
        {earlier > 0 && (
          <Text size="xs" muted>
            {`${earlier} earlier`}
          </Text>
        )}
      </Stack>
    </Collapsible>
  )
}

/** A finding's tone: an issue's ▲ warns, an opportunity's ✦ reads as good news (`FINDING_GROUPS` in `hooks/view.ts`). */
const FINDING_TONES = { issue: 'warning', opportunity: 'success' } as const

/**
 * An issue or opportunity: its mark and title with the age on the right, its detail and file, then the inbox's
 * finding buttons (`actionsOf` in `hooks/view.ts`) less Discuss: Fix or Do it, File issue, Reply, Explain, Copy, Dismiss.
 */
function Finding({ section, row }: { section: InboxSection; row: LabelledFinding }) {
  const { key, label, busy } = rowState(section, row)
  return (
    <Stack gap="xs">
      <Row gap="sm" align="start" justify="between">
        <Row gap="xs" align="start">
          <Text tone={FINDING_TONES[row.kind]}>{row.mark}</Text>
          <Text>{row.title}</Text>
        </Row>
        <Box shrink={false}>
          <Text size="sm" muted>
            {row.age}
          </Text>
        </Box>
      </Row>
      <Text size="sm">{row.detail}</Text>
      {row.fileName !== null && (
        <Text size="sm" muted>
          {`Relevant file: ${row.fileName}`}
        </Text>
      )}
      <Row gap="xs" wrap>
        <Button size="sm" variant="solid" disabled={busy} onPress={() => press(section, row, { action: 'fix' })}>
          {section.trustHook ? `Copy ${row.fix}` : row.fix}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => press(section, row, { action: 'issue' })}>
          {section.trustHook ? 'Copy issue request' : 'File issue'}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => update(replying, m => ({ ...m, [key]: true }))}>
          Reply
        </Button>
        <ExplainButton section={section} row={row} busy={busy} />
        <CopyButton section={section} row={row} source={{ kind: 'finding', title: row.title, detail: row.detail, path: row.path }} busy={busy} />
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => press(section, row, { action: 'dismiss' })}>
          Dismiss
        </Button>
      </Row>
      {read(replying)[key] === true && <ReplyField section={section} row={row} hint={`Your reply to ${section.agent === 'codex' ? 'Codex' : 'Claude'}`} busy={busy} />}
      <Labels rowKey={key} label={label} />
    </Stack>
  )
}

function Group<R>({
  title,
  rows,
  closed,
  draw,
  always = false,
}: {
  title: string
  rows: R[]
  closed: ClosedGroup
  draw: (row: R) => unknown
  /** Show the group, with its empty line, even with nothing open or closed. */
  always?: boolean
}) {
  if (!always && rows.length + closed.total === 0) return null
  return (
    <Stack gap="md">
      <Text size="sm" weight="semibold" muted>{`${title} · ${rows.length}`}</Text>
      {rows.length === 0 ? (
        <Text muted size="sm">{`No open ${title.toLowerCase()}`}</Text>
      ) : (
        rows.map(draw)
      )}
      <ClosedFold group={closed} />
    </Stack>
  )
}

/** Where a plan task's open choice is kept: its session, its place and its title. */
const planKey = (s: InboxSection, n: number, title: string) => `${s.sessionId}:${n}:${title}`

const PLAN_TONES = { done: 'success', needsYou: 'accent', error: 'danger' } as const

/** One plan line as `planLines` gives it: its tone, or dim, and bold. */
function PlanText({ line }: { line: PlanLine }) {
  const tone = line.tone === null || line.tone === 'dim' ? undefined : PLAN_TONES[line.tone as keyof typeof PLAN_TONES]
  return (
    <Text size="sm" muted={line.tone === 'dim'} tone={tone} weight={line.isBold ? 'semibold' : undefined}>
      {line.text}
    </Text>
  )
}

/**
 * The session plan (spec "The session plan", step 3), from `planLines`: "PLAN N of M steps", a progress bar, then one
 * fold per task, in source order within Active and Completed. Completed starts collapsed. A task with a step in progress
 * starts open; a press toggles it. A plan file
 * that cannot be read gives the one error line instead.
 */
function Plan({ section }: { section: InboxSection }) {
  const plan = section.plan
  if (section.planError !== null) return <PlanText line={planLines(null, section.planError)[0]!} />
  if (!plan) return null
  const chosen = read(planOpen)
  const view = { ...plan, tasks: plan.tasks.map((t, n) => ({ ...t, isOpen: chosen[planKey(section, n, t.title)] ?? t.isOpen })) }
  const [head, , ...rest] = planLines(view, null)
  if (!head) return null
  // planLines gives a task line at indent 0 and its steps under it: rebuild one fold per task.
  const tasks: { line: PlanLine; steps: PlanLine[] }[] = []
  for (const line of rest) {
    if (line.indent === 0) tasks.push({ line, steps: [] })
    else tasks.at(-1)?.steps.push(line)
  }
  const entries = tasks.map((lines, n) => ({ lines, task: view.tasks[n]!, n }))
  const isDone = ({ task }: (typeof entries)[number]) => task.steps.every(step => step.mark === 'done')
  const active = entries.filter(entry => !isDone(entry))
  const completed = entries.filter(isDone)
  const drawTask = ({ lines, task, n }: (typeof entries)[number]) => (
    <Collapsible
      key={planKey(section, n, task.title)}
      title={lines.line.text.replace(/^[▸▾] /, '')}
      open={task.isOpen}
      onChange={(open: boolean) => update(planOpen, m => ({ ...m, [planKey(section, n, task.title)]: open }))}
    >
      <Stack gap="xs">
        {lines.steps.map((step, k) => (
          <PlanText key={`step-${k}`} line={step} />
        ))}
      </Stack>
    </Collapsible>
  )
  return (
    <Stack gap="sm">
      <PlanText line={head} />
      <Progress label={head.text} labelHidden value={plan.total === 0 ? 0 : Math.round((plan.done / plan.total) * 100)} />
      {active.length > 0 ? (
        <Stack gap="xs">
          <Text size="sm" weight="semibold" muted>Active</Text>
          {active.map(drawTask)}
        </Stack>
      ) : null}
      {completed.length > 0 ? (
        <Collapsible
          key={`${section.sessionId}:completed-plan`}
          title={`Completed (${completed.length})`}
          open={read(completedPlansOpen)[section.sessionId] ?? false}
          onChange={(open: boolean) => update(completedPlansOpen, m => ({ ...m, [section.sessionId]: open }))}
        >
          <Stack gap="xs">{completed.map(drawTask)}</Stack>
        </Collapsible>
      ) : null}
    </Stack>
  )
}

const hasFindings = ({ findings: f }: InboxSection) =>
  f.issues.length + f.opportunities.length + f.closed.issues.total + f.closed.opportunities.total > 0

/** True when the section has nothing to draw beyond its title. */
function isEmpty(s: InboxSection): boolean {
  const { questions, tasks, closed } = s
  return questions.length + tasks.length + closed.questions.total + closed.tasks.total === 0 && !hasFindings(s) && s.plan === null && s.planError === null && s.tools && !s.trustHook
}

function Section({ section }: { section: InboxSection }) {
  const { questions, tasks, closed, findings } = section
  return (
    <Stack gap="sm">
      <Heading level={3}>{section.title}</Heading>
      {section.trustHook && <Text muted size="sm">Trust the Agent Inbox hook in Codex to send answers</Text>}
      {!section.tools && (
        <Text muted size="sm">
          No tools: this launch set its own MCP, system prompt or settings flags, so Claude cannot record items itself.
          The inbox still reads each finished turn.
        </Text>
      )}
      {isEmpty({ ...section, tools: true }) && (
        <Text muted size="sm">
          Nothing waits on you.
        </Text>
      )}
      <Group
        title="Questions"
        rows={questions}
        closed={closed.questions}
        draw={row => <Question key={row.id} section={section} row={row} />}
      />
      <Group title="Tasks" rows={tasks} closed={closed.tasks} draw={row => <Task key={row.id} section={section} row={row} />} />
      {hasFindings(section) && (
        <>
          <Group
            title="Issues"
            rows={findings.issues}
            closed={findings.closed.issues}
            draw={row => <Finding key={row.id} section={section} row={row} />}
            always
          />
          <Group
            title="Opportunities"
            rows={findings.opportunities}
            closed={findings.closed.opportunities}
            draw={row => <Finding key={row.id} section={section} row={row} />}
            always
          />
        </>
      )}
      <Plan section={section} />
    </Stack>
  )
}

/** An agent the plugin has no tracked section for. */
function otherNote(agent: OtherAgent): string {
  if (agent.agent !== 'codex') return 'Agent Inbox does not track this agent.'
  if (agent.reason === 'launch-skipped') return 'Agent Inbox did not track this Codex launch.'
  if (agent.reason === 'launch-unmatched') return 'Send a prompt in this Codex pane to start tracking it.'
  return 'Started before Agent Inbox; not tracked.'
}

function Other({ agent }: { agent: OtherAgent }) {
  return (
    <Stack gap="sm">
      <Heading level={3}>{agent.title}</Heading>
      <Text muted size="sm">{otherNote(agent)}</Text>
    </Stack>
  )
}

function Footer({ view }: { view: InboxView }) {
  if (view.untracked === 0 && view.unread === 0) return null
  return (
    <Stack gap="sm">
      <Separator />
      {view.untracked > 0 && (
        <Stack gap="none">
          <Text size="sm" muted>{`${count(view.untracked, 'agent', 'agents')} not tracked`}</Text>
          <Text size="xs" muted>
            Started outside Orca's launch, or restored after a restart.
          </Text>
        </Stack>
      )}
      {view.unread > 0 && (
        <Stack gap="none">
          <Text size="sm" muted>{`${count(view.unread, 'turn', 'turns')} not read`}</Text>
          <Text size="xs" muted>
            The inbox model failed on it three times.
          </Text>
        </Stack>
      )}
    </Stack>
  )
}

/** The tracked sections, or their empty state, then agents without a tracked section. */
function Body({ view }: { view: InboxView }) {
  const others = view.others.map(agent => ({ key: `other:${agent.key}`, draw: <Other agent={agent} /> }))
  const sections =
    view.sections.length === 0
      ? []
      : view.sections.every(isEmpty)
        ? [
            {
              key: 'nothing',
              draw: (
                <EmptyState
                  title="Nothing waits on you"
                  description={`${count(view.sections.length, 'agent', 'agents')} tracked, with no open questions or tasks.`}
                  icon="bell"
                />
              ),
            },
          ]
        : view.sections.map(section => ({ key: section.sessionId, draw: <Section section={section} /> }))
  // A workspace with only agents without tracked sections shows their notes.
  const blocks = [...sections, ...others]
  if (blocks.length === 0)
    return (
      <EmptyState
        title={view.untracked > 0 ? 'No tracked agents in this workspace' : 'No agents in this workspace'}
        description="Start Claude Code or Codex from Orca, and its questions and tasks show here."
        icon="bell"
      />
    )
  return (
    <>
      {blocks.map((b, n) => (
        <Stack key={b.key} gap="md">
          {n > 0 && <Separator />}
          {b.draw}
        </Stack>
      ))}
    </>
  )
}

export default function Panel() {
  const state = read(loaded)
  if (state.is === 'loading') return <Text muted>Loading…</Text>
  if (state.is === 'error')
    return (
      <Callout tone="danger" title="Could not load the inbox">
        <Stack gap="sm">
          <Text size="sm">{state.message}</Text>
          <Button size="sm" onPress={load}>
            Try again
          </Button>
        </Stack>
      </Callout>
    )
  return (
    <Stack gap="md">
      <Body view={state.view} />
      <Footer view={state.view} />
    </Stack>
  )
}
