// The inbox panel (spec steps 5 and 6, plan T6): one section per tracked agent in the focused workspace, newest
// activity first, each with its open questions and tasks as in the inbox's Now tab.
// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  plugin,
  read,
  Row,
  Separator,
  shell,
  Stack,
  Text,
  update,
} from 'orca'
import type { ClosedGroup, Step } from './core/now'
import type { InboxSection, InboxView } from './protocol'
import type { LabelledRow, PressInput, RowLabel } from './presses'

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
/** What a row's last local step did: opened a link, or shows text to copy. */
const stepResults = atom<Record<string, RowLabel>>({})

/** What a row reads while its press is out. Done and Dismiss read as the row closing, as the inbox's Mark presses do. */
const PENDING: Record<PressInput['action'], RowLabel> = {
  answer: { text: 'Sending…', tone: 'muted', copy: null },
  step: { text: 'Sending…', tone: 'muted', copy: null },
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

async function press(s: InboxSection, row: LabelledRow, what: PressWhat): Promise<void> {
  const key = rowKey(s, row.id)
  const { action } = what
  update(local, m => ({ ...m, [key]: { label: PENDING[action], pending: true } }))
  const input: PressInput = { terminalId: s.terminalId, sessionId: s.sessionId, drawn: s.drawn, id: row.id, ...what }
  let label: RowLabel
  try {
    const out = await plugin.request('inbox.press', input)
    label = out.ok ? (out.label ?? PENDING[action]) : REFUSED[out.refused]
    if (out.ok && action === 'answer') {
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

/**
 * A local step, as the inbox's `stepEffects` does it where Orca allows: a link opens in the browser. Orca gives a panel
 * no clipboard and no way to open a local file, so a snippet, a command or a path shows as text to select and copy.
 */
async function localStep(s: InboxSection, row: LabelledRow, step: Step): Promise<void> {
  const key = rowKey(s, row.id)
  const parts: string[] = []
  const copies: string[] = []
  let failed = false
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
      copies.push(h.text)
      parts.push(`Select ${h.name ?? 'snippet'} below to copy it`)
    } else if (h.kind === 'terminal') {
      copies.push(h.command)
      parts.push(`Select ${h.name ?? clip(h.command, 32)} below to copy it, then run it in Terminal`)
    } else if (h.kind === 'open') {
      copies.push(h.path)
      parts.push(`Orca cannot open ${baseName(h.path)} from a panel: select its path below to copy it`)
    }
  }
  const isOpenedOnly = copies.length === 0 && !failed
  const label: RowLabel = {
    text: `${isOpenedOnly ? '✓ ' : ''}${parts.join(' · ')}`,
    tone: failed ? 'danger' : isOpenedOnly ? 'success' : 'muted',
    copy: copies.length > 0 ? copies.join('\n') : null,
  }
  update(stepResults, m => ({ ...m, [key]: label }))
  if (label.copy !== null) update(shown, m => ({ ...m, [`step:${key}`]: true }))
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
          {step.label}
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
  void load()
}

function Label({ label, rowId }: { label: RowLabel; rowId: string }) {
  const isShown = read(shown)[rowId] === true
  return (
    <Stack gap="xs">
      <Row gap="sm" align="center" wrap>
        <Text size="sm" muted={label.tone === 'muted'} tone={label.tone === 'muted' ? undefined : label.tone}>
          {label.text}
        </Text>
        {label.copy !== null && (
          <Button size="xs" variant="ghost" onPress={() => update(shown, m => ({ ...m, [rowId]: !isShown }))}>
            {isShown ? 'Hide' : 'Copy'}
          </Button>
        )}
      </Row>
      {label.copy !== null && isShown && <CodeView code={label.copy} label="Select the text to copy it" wrap />}
    </Stack>
  )
}

function rowState(section: InboxSection, row: LabelledRow) {
  const key = rowKey(section, row.id)
  const mine = read(local)[key]
  // A press still out shows its own label. After it, the worker's label wins: it moves on from Sending….
  // A refusal has no worker label, so it stays.
  const busy = mine?.pending === true
  return { key, label: mine && busy ? mine.label : (row.label ?? mine?.label ?? null), busy }
}

/** The reply field a Reply press opens, with Send and Cancel (`ROW_COPY` in the inbox repo's `hooks/view.ts`). */
function ReplyField({ section, row, hint, busy }: { section: InboxSection; row: LabelledRow; hint: string; busy: boolean }) {
  const key = rowKey(section, row.id)
  const draft = read(drafts)[key] ?? ''
  const send = () => {
    if (draft.trim()) void press(section, row, { action: 'answer', answer: draft })
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
          Send
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => update(replying, m => ({ ...m, [key]: false }))}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

/** The row's text, with the question's number before it and the age on the right, as the inbox draws a row. */
function RowHead({ row, truncate }: { row: LabelledRow; truncate?: boolean }) {
  return (
    <Row gap="sm" align="start" justify="between">
      <Text truncate={truncate}>{row.handle ? `${row.handle} ${row.text}` : row.text}</Text>
      {row.age !== null && (
        <Text size="sm" muted>
          {row.age}
        </Text>
      )}
    </Row>
  )
}

/**
 * A question, with buttons in the inbox's order (`rowActions` and `rowKeyPlan` in `hooks/view.ts`): each option, the
 * recommended one first; "All N options" after the fourth when there are more than five; its steps; then Reply and
 * Dismiss.
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
            {c.isRec ? `${c.label} (recommended)` : c.label}
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
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => press(section, row, { action: 'dismiss' })}>
          Dismiss
        </Button>
      </Row>
      {read(replying)[key] === true && <ReplyField section={section} row={row} hint="Your answer" busy={busy} />}
      <Labels rowKey={key} label={label} />
    </Stack>
  )
}

/** A task: its text on one line with its age, then its steps, Done and Reply (`rowActions` in `hooks/view.ts`). */
function Task({ section, row }: { section: InboxSection; row: LabelledRow }) {
  const { key, label, busy } = rowState(section, row)
  return (
    <Stack gap="xs">
      <RowHead row={row} truncate />
      <Row gap="xs" wrap>
        <StepButtons section={section} row={row} busy={busy} />
        <Button size="sm" variant="solid" disabled={busy} onPress={() => press(section, row, { action: 'done' })}>
          Done
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => update(replying, m => ({ ...m, [key]: true }))}>
          Reply
        </Button>
      </Row>
      {read(replying)[key] === true && (
        <ReplyField section={section} row={row} hint="Your reply to Claude" busy={busy} />
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
              <Text size="sm" muted>
                {c.age}
              </Text>
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

function Group({
  title,
  rows,
  closed,
  draw,
}: {
  title: string
  rows: LabelledRow[]
  closed: ClosedGroup
  draw: (row: LabelledRow) => unknown
}) {
  if (rows.length + closed.total === 0) return null
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

function Section({ section }: { section: InboxSection }) {
  const { questions, tasks, closed } = section
  return (
    <Stack gap="sm">
      <Heading level={3}>{section.title}</Heading>
      {questions.length + tasks.length + closed.questions.total + closed.tasks.total === 0 && (
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
      <Group
        title="Tasks"
        rows={tasks}
        closed={closed.tasks}
        draw={row => <Task key={row.id} section={section} row={row} />}
      />
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
  const { view } = state
  const rows = view.sections.reduce((n, s) => n + s.questions.length + s.tasks.length, 0)
  const closed = view.sections.reduce((n, s) => n + s.closed.questions.total + s.closed.tasks.total, 0)
  return (
    <Stack gap="md">
      {view.sections.length === 0 ? (
        <EmptyState
          title={view.untracked > 0 ? 'No tracked agents in this workspace' : 'No agents in this workspace'}
          description="Start Claude Code from Orca, and its questions and tasks show here."
          icon="bell"
        />
      ) : rows + closed === 0 ? (
        <EmptyState
          title="Nothing waits on you"
          description={`${count(view.sections.length, 'agent', 'agents')} tracked, with no open questions or tasks.`}
          icon="bell"
        />
      ) : (
        view.sections.map((section, n) => (
          <Stack key={section.sessionId} gap="md">
            {n > 0 && <Separator />}
            <Section section={section} />
          </Stack>
        ))
      )}
      <Footer view={view} />
    </Stack>
  )
}
