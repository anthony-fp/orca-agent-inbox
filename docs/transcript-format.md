# Claude Code transcript format

What `src/transcript.ts` reads, recorded from local transcripts written by Claude Code 2.1.310 to 2.1.318. No transcript enters this repo; the fixtures in `src/fixtures/` are written by hand in these shapes.

## The file

- One JSON object per line, UTF-8, `\n` after each line. Claude Code appends while the agent works, so the last line can be half-written. The adapter reads only up to the last `\n`.
- The main session file holds the main agent only. Each subagent writes its own file in a `subagents/` folder beside it, with `isSidechain: true` on every line. Older versions wrote subagent lines into the main file with `isSidechain: true`. The adapter skips every line with `isSidechain: true`.
- Every line has `type`. Conversation lines also have `uuid`, `parentUuid`, `sessionId`, `timestamp`, `version`, `cwd` and `isSidechain`.

## Line types

| `type` | What it is | Adapter |
|---|---|---|
| `user` | A prompt, a tool result, or a note Claude Code adds (see below). | Reads |
| `assistant` | One content block of a model message. A message with three blocks writes three lines with the same `message.id`. | Reads |
| `system` | A note, by `subtype`: `turn_duration` (a turn ended), `stop_hook_summary`, `compact_boundary`, `local_command`, `away_summary`, `informational`, `scheduled_task_fire`. | Skips |
| `attachment` | Context Claude Code adds: hook output, `queued_command`, `edited_text_file` and more, in `attachment.type`. | Skips |
| `api-request`, `api-request-blob`, `api-request-shape` | Copies of what was sent to the API. `api-request-blob` has a `message.role` too, so the adapter reads `type`, never `message.role` alone. | Skips |
| `queue-operation`, `last-prompt`, `mode`, `permission-mode`, `ai-title`, `agent-name`, `session-owner`, `file-history-snapshot`, `file-history-delta`, `tools-used`, `pr-link`, `frame-link`, `cost-state`, `atis-latch`, and others | Session bookkeeping. | Skips |

An older format wrote compaction as a line with `type: "summary"`. No local transcript has one.

## `user` lines

`message.role` is `user`. `message.content` is a string, or an array of blocks of type `text`, `image` or `tool_result`.

| Kind | How to tell |
|---|---|
| Tool result | `message.content` has `tool_result` blocks: `tool_use_id`, `content` (a string or an array of `text` blocks) and `is_error`. The line's `toolUseResult` holds the tool's structured result. |
| Prompt that starts a turn | `turnPosition` is present: `{ promptIndex, turnIndex }`. Present since about 2.1.289. |
| A compaction summary | `isCompactSummary: true`. It repeats the `turnPosition` of the turn it follows, so it does not start a turn. |
| An interrupt | A `text` block that starts `[Request interrupted by user`. No `turnPosition`. |
| A shell or local command | Text that starts with `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, `<command-name>` or `<local-command-stdout>`. No `turnPosition`, and no model turn follows. |
| A note Claude Code adds | `isMeta: true` and no `turnPosition`. |

Who started a turn is in `origin.kind` and `turnOrigin`:

| `origin` | `turnOrigin` | Meaning |
|---|---|---|
| `{ kind: "human" }` | `human` | The person typed it. `promptSource` is `typed`, `queued` or `suggestion_accepted`. |
| `{ kind: "plugin", asUser: true }` | `system` | A plugin sent text as the person's words. |
| `{ kind: "peer", ... }` | `peer` | Another agent sent a message. `isMeta: true`. |
| `{ kind: "task-notification" }` | `task_notification` | A background task finished. The same kind also arrives inside a running turn, with no `turnPosition`. |
| none | `sdk`, `scheduled` | An SDK prompt or a scheduled task. |

`turnPosition.promptIndex` counts typed prompts only, and both counters start again when a session is resumed into the same file. So the adapter counts prompts itself.

## `assistant` lines

`message.content` holds exactly one block: `thinking`, `text`, `tool_use` or `server_tool_use`. `message.stop_reason` is the stop reason of the whole message, already on each block's line: a `text` line whose message goes on to call a tool has `stop_reason: "tool_use"`. The final reply's `text` line has `end_turn`.

- `tool_use` has `id`, `name` and `input`. A tool result names it in `tool_use_id`.
- `isApiErrorMessage: true` marks an API error that Claude Code wrote as a `text` line, with `message.model` `<synthetic>`. It is not a reply.

## `AskUserQuestion`

- Call: a `tool_use` with `name: "AskUserQuestion"` and `input.questions`, each with `question`, `header`, `multiSelect` and `options` (`label`, `description`).
- Answered: the `tool_result` is not an error. Its `content` is a string that gives each question and its answer. `toolUseResult` has `questions`, `answers` and `annotations`.
- Dismissed: the `tool_result` has `is_error: true`, and `toolUseResult` is a string.
- Timed out: the inbox mod reads `afkTimeoutMs` in the structured result (inbox repo `hooks/claude.ts`). No local transcript has one; the adapter reads `toolUseResult.afkTimeoutMs`.
- Still open: no `tool_result` for the call yet.

## Compaction

A compaction writes, in order: `system` with `subtype: "compact_boundary"` (`compactMetadata`, `logicalParentUuid`), then a `user` line with `isCompactSummary: true`. The next prompt starts a new turn as usual. Lines before the boundary stay in the file.

## A turn

1. It starts at a `user` line with `turnPosition`, not a compaction summary, not a sidechain.
2. The agent writes `assistant` lines. Each `tool_use` is followed by a `user` line with its `tool_result`. Notes, attachments and mid-turn `task-notification` lines can come between them.
3. It ends with an `assistant` `text` line with `stop_reason: "end_turn"`. Claude Code then writes `system` lines: `stop_hook_summary` and `turn_duration`.
4. An interrupt ends a turn with no reply. The next prompt starts a new turn.

A prompt the person types while the agent works can arrive as an `attachment` with `type: "queued_command"` inside the running turn. The adapter does not read it yet.
