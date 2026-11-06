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
>
> **---- refresh 2026-11-05: Part 3 (Codex, T14–T21) ----**
>
> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-05) — HIGH. Do not ship Part 3 yet: first-turn tools cannot reliably write, and the proposed transcript copy does not supply the durable turn boundary the tracker requires.**
>
> The audit found: T17 creates the pane-to-thread mapping only after the first turn's `notify`, so a `record` or `close` during the first turn cannot wait for its own turn to finish within 5 s; it returns "not available" and the finding is lost (plan T17, spec step 6). `turnIn` returns only dialogs and commands, and `readRollout` returns a flattened conversation and an earlier-turn count (inbox repo `codex/src/transcript.ts:198`, `:423`); neither returns one `Exchange`, a byte offset and the next complete turn that the queue requires (`src/turns.ts:88-98`, `:187-225`). The full `notify` payload includes `last-assistant-message`, and the socket drops requests over 1 MiB (`src/socket.ts:129-130`), so a long reply discards the turn notification. T18 caps `codex exec` at 45 s while the referenced runner allows 120 s (inbox repo `codex/src/update.ts:31-33`); under the three-failure rule (`src/turns.ts:171-180`) slow but healthy runs cause permanent inbox gaps. Probe C1 (run during the audit): a `UserPromptSubmit` hook given with `-c hooks.UserPromptSubmit=[…]` did not run under `codex exec` on 0.164.0; Codex keeps hook trust by source and hash in `hooks.state`.
>
> **Redesign required before build:**
> 1. **Bind the pane to its thread before any tool can run.** In T14, probe whether the MCP server can find its own thread at start: the rollout its parent `codex` process holds open (`lsof -p <ppid>`), or thread metadata in the MCP request. In T17, bind at the first tool call, not at `notify`. Test a `record` in the first turn.
> 2. **Write a real Codex turn adapter.** In T15, copy the readers, then add `readCodexTurn(file, offset) → { status, turnId, exchange, nextOffset }` with the same contract as `readTurn` (T3). `turnId` is the rollout's turn id. Test multi-turn catch-up after a restart and a `codex resume`.
> 3. **Send only ids in `codex-turn`.** In T17, `bin/codex-notify.mjs` sends `{ paneKey, codexHome, threadId, turnId, type }` and drops the rest. Test a payload over 1 MiB.
> 4. **Use 120 s for `codex exec`, and never drop a turn on timeout alone.** In T18, a timeout does not count toward the three failures. Test a slow run.
> 5. **Settle the prompt hook in T14.** Probe the TUI (not `exec`) for a trust prompt on a `-c` hook, and the `hooks.json` route. If neither works without a trust bypass, the agent gets close ids from the tool answers only. Never set `bypass_hook_trust` or write `hooks.state` for the user.
>
> **Status:** Fixes 1–5 written into T14, T15, T17 and T18 on 2026-11-05. T17 waits on T14 step 5.

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
- Type check: Orca 1.4.248 ships no `orca.d.ts`, so the root `tsconfig.json` cannot load. `src/core/` imports nothing from Orca, so it gets its own `src/core/tsconfig.json` with no `extends`, and `npm run typecheck` runs `tsc --noEmit -p src/core`.
- Test: `npm run typecheck` passes. Port the inbox repo's tests for `applyExchangeUpdate` and `buildPrompt`, and they pass unchanged. New tests for `nowRows`: an empty ledger, open questions with options, tasks, closed items left out.

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
- Do: a send whose result is not certain reads "Not delivered" with Copy. The plugin never sends it again by itself. As built: only the sent prompt itself, seen in the transcript within 10 s, confirms delivery. A `working` status during the send does not count against it, because the sent prompt starts the agent working; a different prompt first, a refused send, or no prompt in 10 s reads "Not delivered" (`src/presses.ts:17`, `:118`).
- Test: a fake terminal and a fake status for each state: `done`, `working`, `blocked`, `waiting`. Also: a status change to `working` between the press and the send; a new session in the terminal between the press and the send; a turn that ends between the draw and the press; a send with no new prompt within 10 s.

## T8. Live check and README
- Files: `README.md`, `docs/live-check.md`.
- First (from T2): with the plugin loaded, log the real `command` of 3 Orca launches: a new tab, a launch with a prompt, and a workspace create. `tagLaunch` leaves any command with `$VAR`, `$(...)` or a shell operator untracked (`src/launch.ts:63`). If Orca builds its launch commands that way, every agent would be untracked, so fix `tagLaunch` before the other checks. Also run `orca plugin dev hook agent.launch.before` on one of those commands.
- First (from T11): in a tracked session, `/mcp` lists `orca-inbox` beside the user's own MCP servers (`--mcp-config` adding, not replacing, is not tested yet). A real Orca launch with the multi-line guidance starts cleanly. The user's own `UserPromptSubmit` hooks still run.
- Do: load with `orca plugin dev load .`. Start two `claude` agents in one workspace from Orca. Check each "Done means" line in the spec, and three agents for panel length. The README lists each capability and the hook with what it is for, and says that the plugin runs `claude -p` on your account after each turn.
- Test: `docs/live-check.md` records each check with its result and the measured time from `done` to the row showing. Say which states were not seen.

# Part 2 — findings and the session plan

Builds spec sections "The agent's tools (findings)" and "The session plan". Same rules as above. T8 (live check) moves to the end and covers part 2 too.

**Order:** T9 → (T10, T11 at the same time) → T12 → T13 → T8. T12 starts only after the row change to the panel is committed.

## T9. Copy the tool and plan code
- Files: `src/core/tools.ts`, `src/core/plan.ts`, `src/core/tones.ts` (only what `plan.ts` needs), `src/core/types.ts`, `src/core/tools.test.ts`, `src/core/plan.test.ts`, `src/core/model-text.ts` (the `ORCA` host only), `NOTICE.md`.
- Do: copy `agentTools`, `recordItem`, `recordClose` and what they need from the inbox repo's `hooks/tools.ts`, and `hooks/plan.ts` whole. Import paths only. Give `ORCA` its real `recordTool` (`mcp__orca-inbox__record`), `closeTool` (`mcp__orca-inbox__close`) and an `intro` that names the Orca panel, written as the `CLAUDE_CODE` intro is.
- Test: port the inbox repo's tests for these functions and `tests/plan.test.ts`; they pass. `systemText(ORCA)` is unchanged from before T9 (a test pins it).

## T10. Worker socket, MCP server and prompt hook
- Files: `src/socket.ts`, `src/socket.test.ts`, `bin/mcp-server.mjs`, `bin/prompt-hook.mjs`, `src/worker.ts`, `src/state.ts`, `src/turns.ts`.
- Do: spec "The agent's tools" steps 2–4 and "The session plan" steps 1–2. The worker listens on a 0600 socket in the plugin's folder. Messages: `prompt-start` (raise and save the active turn), `inbox-text` (`inboxText(ORCA, …)`, `closedText`, `planNote`), `record`, `close`. The two `bin/` scripts are plain Node with no dependencies, answer within 5 s or give up as the spec says. The MCP server speaks stdio MCP with `agentTools(ORCA)`.
- Test: socket round trips with a fake ledger; the turn-stamp cases from spec step 4; a worker restart; a script run against a fake socket that never answers.

## T11. Launch hook adds the tools
- Files: `src/launch.ts`, `src/launch.test.ts`.
- Do: spec "The agent's tools" step 1. Add `--mcp-config`, `--append-system-prompt <guidanceText(ORCA)>` and `--settings` to a tracked launch. Skip all three, and mark the session "no tools", when the command already has any of `--mcp-config`, `--strict-mcp-config`, `--append-system-prompt` or `--settings`. Quote every added value safely.
- Test: each skip case; the added flags parse back to the same values; a prompt argument still comes last.

## T12. Panel: findings and plan
- Files: `src/panel.tsx`, `src/panel.test.tsx`, `src/panel-views.ts`, `src/panel.check.ts`, `src/protocol.ts`, `src/worker.ts`.
- Do: "Issues · N" and "Opportunities · N" with the inbox's finding rows and buttons, less the actions version 1 leaves out, and "▸ N closed". The PLAN section per spec "The session plan" step 3, with collapsible tasks. "No tools" on an agent's section when T11 skipped its tools.
- Do (mirror fixes from the row change, `f76735d`): a typed reply on a question no longer closes it at once; the inbox model decides, as the inbox does (inbox repo `hooks/presses.ts:803-807`). A sent press reads "✓ <button label>", as the inbox does, not "✓ Replied" or "✓ Answered". Copy uses a worker request that writes the clipboard (`pbcopy` on macOS), so Copy reads "✓ Copied"; where that fails, keep the select-the-text box.
- Do (user request): an agent in the focused workspace whose `agent` (from `agents.list`) is not `claude` gets its own short section: its title, then "Agent Inbox supports Claude Code only for now. Codex support is coming soon." Such agents no longer count in "N agents not tracked", which keeps only Claude agents the plugin did not see launch. When every agent in the workspace is not Claude, the panel shows only these sections.
- Test: findings rows and order; plan open and closed by default; a toggle; the progress count; a Codex agent's section and its text; a workspace with only a Codex agent; a typed reply leaves the question open until the model runs; the press labels; Copy.

## T13. Agent eval
- Files: `docs/agent-eval.md`.
- Do: in a temporary copy of the inbox repo (never in the real clone), add the `ORCA` host and run `./scripts/eval.sh --suite agent --agent claude` once with `ORCA` and once with `CLAUDE_CODE`. Quote both results files.
- Also (from T10): the new tool answer "The inbox is not available, so this was not saved." (`bin/mcp-server.mjs:20`) and the joined prompt notes (`src/socket.ts:107-111`) are text a model reads. Add one case where `record` answers "not available", and check the agent does not claim the item was saved.
- Test: `ORCA` passes every case that `CLAUDE_CODE` passes. A case that fails only with `ORCA` blocks T8.

# Part 3 — Codex (version 2)

Builds spec section "Codex (version 2)". Same rules as above. "The inbox repo" includes its `codex/` folder.

**Order:** T14 → T15 → (T16, T17, T18 at the same time) → T19 → T20 → T21. A probe that fails in T14 changes the spec before any later task starts.

## T14. Codex probes
- Files: `docs/codex-probes.md`.
- Do: settle risks C1–C3 with real runs, each in a scratch folder outside the repo, with no session content recorded.
  1. C2: with the plugin loaded as a dev plugin, log the `agent` and `command` of a Codex launch from a new tab, a launch with a prompt, and a `codex resume`.
  2. C1: run `codex` with `-c 'hooks.UserPromptSubmit=[…]'` (and the `hooks.json` form if `-c` is refused) and record whether the hook runs, whether Codex asks to trust it, and what its output does.
  3. C3: one Codex turn that starts a sub-agent, with a logging `notify`. Record each `notify` payload's `thread-id`, and whether the main thread's id can be told apart (the `threads.source` column in `state_5.sqlite`).
  4. Record whether `mcp_servers.<name>.env_vars` passes `ORCA_PANE_KEY` to an MCP server in Codex 0.164.0.
  5. Audit fix 1: from inside an MCP server started by Codex, find the thread: the rollout file its parent `codex` process holds open (`lsof -p <ppid>`), or thread metadata in the `tools/call` request. Record which works.
  6. Audit fix 5: C1 under `codex exec` failed (a `-c` `UserPromptSubmit` hook did not run). Probe the TUI for a trust prompt on a `-c` hook, then the `hooks.json` route. Never set `bypass_hook_trust` or write `hooks.state`.
- Test: each probe has a result line in `docs/codex-probes.md`. If C1 fails, edit spec step 1 before T16.

## T15. Copy the Codex code
- Files: `src/core/codex-transcript.ts`, `src/core/codex-transcript.test.ts`, `src/core/model-text.ts` (an `ORCA_CODEX` host), `NOTICE.md`.
- Do: copy `rolloutFor`, `turnIn`, `readRollout` and what they need from the inbox repo's `codex/src/transcript.ts`, import paths only. Add `ORCA_CODEX`: the `ORCA` host with Codex's tool names, as the inbox repo's Codex host names them (`codex/src/texts.ts`).
- Do (audit fix 2): add `readCodexTurn(file, offset) → { status, turnId, exchange, nextOffset }`, the same contract as `readTurn` (T3), built on the copied readers. `turnId` is the rollout's turn id. It never parses a half-written last line.
- Test: port the inbox repo's tests for these functions. `systemText(ORCA)` stays pinned and unchanged. Hand-written rollout fixtures: one turn, three turns read in one catch-up after a restart, a `codex resume` that appends to the same file, a half-written last line.

## T16. Launch hook for Codex
- Files: `src/launch.ts`, `src/launch.test.ts`.
- Do: spec "Codex (version 2)" step 1. `tagLaunch` returns `{ kind: 'codex' }` for a Codex launch (the form from T14 C2) and adds the `-c` flags: `notify`, `mcp_servers.orca-inbox.*`, `developer_instructions`, and the prompt hook if C1 passed. A command that already sets any of them is not tracked. Quote each value as TOML inside a shell word.
- Test: plain `codex`; `codex` with a prompt; `codex resume <id>`; `codex exec` (not tracked); each skip case; the added values parse back as TOML; a prompt argument still comes last; every Claude case from T2 and T11 is unchanged.

## T17. Notify client and pane tracking
- Files: `bin/codex-notify.mjs`, `src/socket.ts`, `src/socket.test.ts`, `src/state.ts`, `src/worker.ts`, `src/worker.test.ts`.
- Do: spec steps 2, 3 and 6. A new socket message `codex-turn { paneKey, codexHome, payload }`. The script sends only `{ paneKey, codexHome, threadId, turnId, type }` and drops the rest of the payload (audit fix 3). The state gains `panes: { [paneKey]: { agent: 'codex', threadId, codexHome } }`, with `upgradeState` from version 1. The worker keeps only the main thread (T14 C3). The MCP server binds its pane to its thread at its first tool call, by the method T14 step 5 found, and the worker saves it before it answers (audit fix 1). A later `codex-turn` with a new thread id replaces it. The script runs the person's own `notify` from `$CODEX_HOME/config.toml` after it reports.
- Test: a version 1 state upgrades; a `codex-turn` maps a pane; a second thread id in the pane replaces the first; a sub-agent thread is ignored; a `record` in the first turn, before any `codex-turn`, is saved; a payload over 1 MiB from Codex still reports its ids; the script against a socket that never answers exits in 5 s and still runs the person's `notify`.

## T18. Codex turns and the Codex model runner
- Files: `src/turns.ts`, `src/turns.test.ts`, `src/model.ts`, `src/model.test.ts`.
- Do: spec steps 4 and 5. A Codex turn completes at the later of `notify` and `done`, then goes through the same durable queue as T4. The exchange comes from `turnIn`/`readRollout`. The runner picks `codex exec` for a Codex session, with the inbox repo's flags (`codex/src/update.ts:110-135`), its `MODEL`, low effort, and the pane's `CODEX_HOME`; kill at 120 s, as the inbox repo does. A timeout leaves the turn in the queue and does not count toward the three failures (audit fix 4).
- Test: a fake rollout and fake `notify`/`done` in each order; a missing rollout; a stubbed `codex exec` with a good answer, a bad answer, a timeout, and four timeouts in a row that still keep the turn; a Claude session still runs `claude -p`.

## T19. Panel and presses for Codex
- Files: `src/panel.tsx`, `src/panel.test.tsx`, `src/presses.ts`, `src/presses.test.ts`.
- Do: spec step 7. A tracked Codex agent gets the same section as a Claude agent. The "Codex support is coming soon" section from T12 shows only for a Codex agent the plugin did not see launch, with the text "Started before Agent Inbox; not tracked." A press confirms delivery from the rollout's next prompt.
- Test: a tracked Codex agent's rows; an untracked Codex agent; a press to a Codex terminal in each `mainAgent.state`.

## T20. Evals
- Files: `docs/agent-eval.md`, `docs/model-compare.md`.
- Do: spec risk C4. In a temporary copy of the inbox repo, run `./scripts/eval.sh --suite agent --agent codex` with `ORCA_CODEX`, and `./scripts/eval.sh` for the `codex exec` model. Quote both results files.
- Test: `ORCA_CODEX` passes every case the inbox repo's Codex host passes.

## T21. Live check, README, release
- Files: `README.md`, `docs/live-check.md`, `orca-plugin.json`, `package.json`.
- Do: load the dev plugin. Start two Codex agents in one folder and one Claude agent. Check: each pane gets its own rows; a question, a task and a finding from each; an answer press reaches the right Codex pane; a `codex resume` stays tracked; the person's own `notify` still runs. README says what the Codex flags do and that the plugin runs `codex exec` on that account. Description ends "Works with Claude Code and Codex." Version `0.2.0`.
- Test: `docs/live-check.md` records each check. Then tag `v0.2.0` (after the user's OK).
