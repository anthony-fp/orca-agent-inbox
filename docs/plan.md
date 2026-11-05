# Agent Inbox for Orca — build plan

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-05) — HIGH. Do not ship the plan yet: turn recovery and send safety are undefined, and two copy assumptions conflict with the referenced code.**
>
> The audit found: turn completion has no durable model-work boundary, so a restart between the T4 offset write and the T5 ledger write can lose a turn or apply it twice (the mod keeps pending exchanges and checks identity before it applies a result, inbox repo `hooks/session-host.ts:168-174`). A done-state check does not make sending safe: the agent can start another turn between the check and `terminal:send`. T3 rests on the wrong reference: the mod never parses JSONL; it gets messages from `$.session.messages()` (`hooks/register.tsx:1040`). T5 does not reproduce the mod's model call (`$.model.complete`, Sonnet, `maxTokens: 1600`, `effort: 'low'`, 45 s timeout, `hooks/claude-host.ts:429-436`), and `systemText(CLAUDE_CODE)` describes an `/inbox` pane and a band this plugin does not have (`hooks/model-text.ts:271-279`). T1 cannot be a clean copy: `ledger.ts` and `model-text.ts` import `../types` (`types/index.d.ts`), and the Now view calls press helpers (`hooks/view.ts:20-37`, `684-793`).
>
> **Redesign required before build:**
> 1. **Make each turn durable.** In T4, give each parsed exchange a stable turn id and save it before the model runs. Run the model one at a time per session. Save the result, the ledger and the offset in one write. Test a crash at each boundary and two overlapping `done` events.
> 2. **Recheck just before sending.** In T7, read the terminal's session and `mainAgent.state` again right before `terminal:send`. Refuse a stale press. Test a status change and a session change during the send. An unsure delivery shows as not confirmed and is never retried on its own.
> 3. **Base T3 on real JSONL.** Start T3 by recording the line types in a few real local transcripts (kept out of the repo). Then write the fixtures to match those shapes: tool results, `AskUserQuestion` outcomes, compaction and sidechain lines.
> 4. **Match the mod's model call, and give the plugin its own `Host`.** In T5, set the `claude -p` flags to match Sonnet, low effort, 1600 output tokens, 45 s timeout. Add an `ORCA` `Host` whose names describe the Orca panel. Compare its classifications with the mod's on the same exchanges before keeping it, as "Text a model reads" requires.
> 5. **Copy the types, and cut the Now view free before parallel work.** In T1, copy `types/index.d.ts` too. Define a small Now projection that needs no press state. Move panel integration (T6) after T4 and T7 settle the state and press contracts.
>
> **Status:** Fixes 1–5 written into T1, T3, T4, T5, T6 and T7 on 2026-11-05. Not blocked.

Builds `docs/spec.md` (version 1, Claude Code only). One subagent per task. A failing test blocks the next task.

**Rules for every task**
- The repo will be public. Test fixtures are written by hand. Never copy a real transcript, a private path or session content into the repo.
- `orca plugin validate .` and `npm test` pass after every task.
- The copied text a model reads (`systemText`, `buildPrompt`) stays word for word. A change to it needs a model comparison first, as in the inbox repo's `AGENTS.md` "Text a model reads".
- "The inbox repo" means `github.com/anthony-fp/inbox`. A builder reads it from a local clone and passes the path in the task prompt; no local path goes into this repo.

**Order:** T0 → T1 → (T2, T3, T5 at the same time) → T4 → T7 → T6 → T8. The panel comes last of the code tasks, so it builds on settled state and press contracts (audit fix 5).

## T0. Skeleton
- Files: `orca-plugin.json`, `package.json`, `tsconfig.json`, `src/worker.ts`, `src/panel.tsx`, `src/protocol.ts`, `README.md`, `.gitignore`.
- Do: `orca plugin create` with the `worker-panel` template, in this repo. Manifest: id `agent-inbox`, panel `inbox` with an inbox icon, capabilities `agent:read`, `terminal:send`, `storage:own`, `workspace:read`, hook `agent.launch.before`, event `agent.status.changed`, `engines.orca` `>=1.4.248`.
- Test: `orca plugin validate .` and `orca plugin check .` pass. The panel renders an empty state.

## T1. Copy the shared code
- Files: `src/core/ledger.ts`, `src/core/model-text.ts`, `src/core/text.ts`, `src/core/types.ts`, `src/core/now.ts`, `src/core/*.test.ts`, `LICENSE`, `NOTICE.md`.
- Do: copy `hooks/ledger.ts`, `hooks/model-text.ts`, `hooks/text.ts`, and the types they use from `types/index.d.ts` into `src/core/types.ts`. Keep the inbox repo's license. `NOTICE.md` names the source repo and commit.
- Do: write `src/core/now.ts` new, not as a copy of `hooks/view.ts` (it calls press helpers at `hooks/view.ts:20-37` and `684-793`). It is a small Now projection: `nowRows(ledger) → { questions, tasks }`, each row with its text, options and id. It takes no press state. T7 adds the press label to a row.
- Test: `tsc --noEmit` passes. Port the inbox repo's tests for `applyExchangeUpdate` and `buildPrompt`, and they pass unchanged. New tests for `nowRows`: an empty ledger, open questions with options, tasks, closed items left out.

## T2. Launch tagging
- Files: `src/launch.ts`, `src/launch.test.ts`.
- Do: a pure function `tagLaunch(command) → { command, session: { id, kind: 'new' | 'resume' } | null }`, per spec step 1. It only adds `--session-id <uuid>` to a new `claude` session. It never changes any other command.
- Test: a case for each form: plain `claude`; `claude` with a prompt; `--resume <uuid>`; `--resume <name>`; `--resume` alone; `--continue`; `--fork-session`; a `claude` with an existing `--session-id`; a quoted path that contains "claude"; `codex`. Then `orca plugin dev hook agent.launch.before` on a real command prints the expected result.

## T3. Transcript adapter
- Files: `src/transcript.ts`, `src/transcript.test.ts`, `src/fixtures/*.jsonl`.
- First: the mod never reads this file format; Claude Code hands it messages through `$.session.messages()` (`hooks/register.tsx:1040`). So start by reading 3–5 real transcripts in `~/.claude/projects/`: one with tools, one with an `AskUserQuestion`, one with a compaction, one with a subagent. Record each line type and the fields the adapter needs in `docs/transcript-format.md`, with no session content. Real transcripts never enter the repo.
- Do: `readTurn(file, offset) → { status: 'complete' | 'pending' | 'incomplete', turnId, exchange, nextOffset }`, per spec steps 2–3. `turnId` is the uuid of the turn's prompt line. It builds `person`, `trigger`, `activity` (each tool call, and each `AskUserQuestion` with its outcome), `reply` and `turn`. It skips sidechain (subagent) lines. It reads by byte offset and never parses a half-written last line.
- Test: hand-written fixtures that copy the shapes in `docs/transcript-format.md`: a plain turn, a turn with tools, a dialog turn, a half-written last line, an interrupted turn followed by a new prompt, compaction lines and sidechain lines. Then one local-only check: run `readTurn` over the real transcripts from the first step and confirm each turn has a reply or is `incomplete`. Record the count, not the content.

## T4. Turn tracker and state
- Files: `src/state.ts`, `src/turns.ts`, `src/turns.test.ts`.
- Do: the saved state: `{ version: 1, terminals: { [terminalId]: { sessionId } }, sessions: { [sessionId]: { offset, queue: Turn[], ledger, lastTurnId } } }`, with `upgradeState`. `Turn` is `{ turnId, exchange, nextOffset }`.
- Do: the pending rules from spec step 2: read once a second for 15 s, complete after 2 s with no growth, `incomplete` when a later prompt arrives, retry on the next `done` and at startup.
- Do: a durable turn boundary (audit fix 1).
  1. A complete turn is added to `queue` and saved before the model runs. The offset does not move yet.
  2. One worker loop per session takes the first turn in `queue` and runs the model. A second `done` only adds to `queue`.
  3. With the model's answer, one storage write saves the new `ledger`, sets `offset` to the turn's `nextOffset`, sets `lastTurnId` and removes the turn from `queue`.
  4. A turn whose `turnId` equals `lastTurnId` is never applied again.
  5. At startup, the worker runs every turn still in `queue`.
  6. A model failure leaves the turn in `queue` and retries it at the next `done` or startup, at most 3 times. After 3 failures, the turn is dropped and the panel shows "1 turn not read".
- Test: a fake clock, a fake file, fake storage and a fake model. Cases: a `done` before the file is written; a repeated `done`; two overlapping `done` events; an incomplete turn followed by a complete one; a crash after the queue write; a crash after the model answers but before the commit write; a model that fails 3 times. After each crash, a restart applies each turn exactly once.

## T5. Inbox model runner
- Files: `src/model.ts`, `src/model.test.ts`, `src/core/model-text.ts` (the `ORCA` host only), `docs/model-compare.md`.
- Do: match the mod's call (`hooks/claude-host.ts:429-436`): Sonnet, low effort, 1600 output tokens at most, 45 s timeout. Run `claude -p --model sonnet --effort low --no-session-persistence --strict-mcp-config --setting-sources "" --tools "" --system-prompt <systemText(ORCA)>` with `buildPrompt` on stdin, and kill it at 45 s. If a flag does not exist in `claude --help`, record what was used instead in `docs/model-compare.md`. Parse the answer as the mod does.
- Do: add an `ORCA` `Host` next to `CLAUDE_CODE` (`hooks/model-text.ts:271-279`). Its `surface` names the Orca inbox panel, it has no band, and it has no record or close tools. No other text that a model reads changes.
- Test: a stubbed process for a good answer, a bad answer and a timeout.
- Test: a model comparison, as the inbox repo's `AGENTS.md` "Text a model reads" says. Print `systemText(CLAUDE_CODE)` and `systemText(ORCA)` for the same 5 hand-written exchanges. Run each 5 times. Count the items each version adds and closes. Keep `ORCA` only when the counts match within 1 item for each exchange. Write the counts and the median run time (spec risk 1) in `docs/model-compare.md`.

## T6. Panel
- Files: `src/panel.tsx`, `src/panel.test.tsx`, `src/panel.check.ts`, `src/protocol.ts`.
- Starts after T4 and T7, so the state and the press labels are settled.
- Do: one section per tracked agent in the focused workspace, newest activity first, with the rows from `nowRows` and the press labels from T7. A line with the count of agents that are not tracked, and "1 turn not read" from T4 when it applies. Buttons in the order the Now plan gives.
- Test: `panel.test.tsx` for zero, one and three agents. `orca plugin shot` in both themes at the sidebar's narrow width.

## T7. Presses
- Files: `src/presses.ts`, `src/presses.test.ts`, `src/worker.ts`.
- Do: spec step 6. Row text: "Sending…", "✓ Answered", "Waits for the agent" with Copy, red "Not delivered" with Copy after 10 s. Done and Dismiss close the row in state only.
- Do: a send check right before the send (audit fix 2). Each press carries the `terminalId`, `sessionId` and `lastTurnId` that the row was drawn with. Just before `terminal:send`, in the same tick, the worker checks all of these:
  1. The terminal still maps to that `sessionId`.
  2. The newest `agent.status.changed` for the terminal says `mainAgent.state` is `done`, and no `working` came after it.
  3. The session's `lastTurnId` and `queue` are unchanged since the row was drawn.
  If any check fails, the row reads "Waits for the agent" and nothing is sent. A press for a row that has closed since it was drawn is refused.
- Do: a send whose result is not certain, because the status changed during the send or no new prompt appeared within 10 s, reads "Not delivered" with Copy. The plugin never sends it again by itself.
- Test: a fake terminal and a fake status for each state: `done`, `working`, `blocked`, `waiting`. Also: a status change to `working` between the press and the send; a new session in the terminal between the press and the send; a turn that ends between the draw and the press; a send with no new prompt within 10 s.

## T8. Live check and README
- Files: `README.md`, `docs/live-check.md`.
- Do: load with `orca plugin dev load .`. Start two `claude` agents in one workspace from Orca. Check each "Done means" line in the spec, and three agents for panel length. The README lists each capability and the hook with what it is for, and says that the plugin runs `claude -p` on your account after each turn.
- Test: `docs/live-check.md` records each check with its result and the measured time from `done` to the row showing. Say which states were not seen.
