// The inbox panel (spec steps 5 and 6, plan T6): one section per tracked agent in the focused workspace, newest
// activity first, each with its open questions and tasks as in the inbox's Now tab.
// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Button,
  Callout,
  CodeView,
  EmptyState,
  Heading,
  Input,
  plugin,
  read,
  Row,
  Separator,
  Stack,
  Text,
  update,
} from 'orca'
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

/** What a row reads while its press is out. Done and Dismiss read as the row closing, as the inbox's Mark presses do. */
const PENDING: Record<PressInput['action'], RowLabel> = {
  answer: { text: 'Sending…', tone: 'muted', copy: null },
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

async function press(s: InboxSection, row: LabelledRow, action: PressInput['action'], answer?: string): Promise<void> {
  const key = rowKey(s, row.id)
  update(local, m => ({ ...m, [key]: { label: PENDING[action], pending: true } }))
  const input: PressInput = { terminalId: s.terminalId, sessionId: s.sessionId, drawn: s.drawn, id: row.id, action }
  if (answer !== undefined) input.answer = answer
  let label: RowLabel
  try {
    const out = await plugin.request('inbox.press', input)
    label = out.ok ? (out.label ?? PENDING[action]) : REFUSED[out.refused]
    if (out.ok && action === 'answer') update(drafts, m => ({ ...m, [key]: '' }))
  } catch (e) {
    label = { text: `Not sent: ${message(e)}`, tone: 'danger', copy: null }
  }
  update(local, m => ({ ...m, [key]: { label, pending: false } }))
  await load()
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

/** A question: a button per option, the field and Reply, then Dismiss: the inbox's order (hooks/view.ts). */
function Question({ section, row }: { section: InboxSection; row: LabelledRow }) {
  const { key, label, busy } = rowState(section, row)
  const draft = read(drafts)[key] ?? ''
  const reply = () => {
    if (draft.trim()) void press(section, row, 'answer', draft)
  }
  return (
    <Stack gap="xs">
      <Text>{row.text}</Text>
      {row.options.length > 0 && (
        <Row gap="xs" wrap>
          {row.options.map(option => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              disabled={busy}
              onPress={() => press(section, row, 'answer', option)}
            >
              {option}
            </Button>
          ))}
        </Row>
      )}
      <Input
        label="Your answer"
        labelHidden
        placeholder="Your answer"
        value={draft}
        disabled={busy}
        onChange={(v: string) => update(drafts, m => ({ ...m, [key]: v }))}
        onSubmit={reply}
      />
      <Row gap="xs" wrap>
        <Button size="sm" variant="outline" disabled={busy || !draft.trim()} onPress={reply}>
          Reply
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => press(section, row, 'dismiss')}>
          Dismiss
        </Button>
      </Row>
      {label && <Label label={label} rowId={key} />}
    </Stack>
  )
}

/** A task: Done, then Dismiss. */
function Task({ section, row }: { section: InboxSection; row: LabelledRow }) {
  const { key, label, busy } = rowState(section, row)
  return (
    <Stack gap="xs">
      <Text>{row.text}</Text>
      <Row gap="xs" wrap>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => press(section, row, 'done')}>
          Done
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => press(section, row, 'dismiss')}>
          Dismiss
        </Button>
      </Row>
      {label && <Label label={label} rowId={key} />}
    </Stack>
  )
}

function Section({ section }: { section: InboxSection }) {
  const { questions, tasks } = section
  return (
    <Stack gap="sm">
      <Heading level={3}>{section.title}</Heading>
      {questions.length + tasks.length === 0 && (
        <Text muted size="sm">
          Nothing waits on you.
        </Text>
      )}
      {questions.length > 0 && (
        <Stack gap="md">
          <Text size="sm" weight="semibold" muted>{`Questions · ${questions.length}`}</Text>
          {questions.map(row => (
            <Question key={row.id} section={section} row={row} />
          ))}
        </Stack>
      )}
      {tasks.length > 0 && (
        <Stack gap="md">
          <Text size="sm" weight="semibold" muted>{`Tasks · ${tasks.length}`}</Text>
          {tasks.map(row => (
            <Task key={row.id} section={section} row={row} />
          ))}
        </Stack>
      )}
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
  return (
    <Stack gap="md">
      {view.sections.length === 0 ? (
        <EmptyState
          title={view.untracked > 0 ? 'No tracked agents in this workspace' : 'No agents in this workspace'}
          description="Start Claude Code from Orca, and its questions and tasks show here."
          icon="bell"
        />
      ) : rows === 0 ? (
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
