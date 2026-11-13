# Live check (T8)

First run: 2026-11-05, Orca 1.4.248, Claude Code 2.1.318. The plugin was loaded with `orca plugin dev load` and approved with `orca plugin dev reload --approve`. All agents ran in a throwaway git folder that was opened as a folder workspace. Times are local wall-clock.

The run stopped after check 3. A bug (below) blocks the checks that need the transcript, and T8 runs again after the fix.

## Bug: workspace ids do not match

Fixed after this run: the plugin finds the transcript by the session id, reads the folder from the transcript's `cwd` or the prompt hook's `cwd`, and prunes only by age (docs/spec.md, step 2). T8 runs again on the fix.

- `agent.launch.before` gives `workspaceId` as `<repoId>::<path>`. The plugin saves that value in `terminals[...].workspaceId`.
- Orca's `workspace.list` gives `id: identity:<identity key>` for each workspace that has an identity, and every folder and worktree here has one. The plugin keys its map by that id (`src/worker.ts:85`).
- Effect 1: `dirOf` (`src/worker.ts:93`) never finds the folder. The transcript is never read, so the inbox model never runs: `offset` stays 0 and `lastTurnId` stays null after three turns. A question the agent asks only in its reply never shows. A press label stays at `sending`.
- Effect 2: the plan note is null, so the prompt hook prints nothing. A run of `bin/prompt-hook.mjs` by hand for a tracked session gave empty stdout and exit 0.
- Effect 3: `prune` (`src/turns.ts:287`) drops every terminal at each worker start. Each change to the plugin folder makes Orca restart the worker. At 18:22:40, a commit to the folder restarted the worker, and the terminals of three tracked agents went from storage while their sessions stayed.

## 1. The real launch command: pass

- A new tab (`orca agent launch --agent claude`, the same launch as the app's new agent tab) and a launch with `--prompt` both start `claude --plugin-dir '<Orca agent-view plugin, path with a space>' <the person's own args>`, with the prompt as the last word. The command has no `$VAR`, substitution or shell operator.
- `tagLaunch` tracks it. The running process has `--session-id`, `--mcp-config`, `--append-system-prompt` and `--settings` right after `claude`, and the person's own flags follow unchanged. `terminalId` is the Orca terminal handle, `term_<uuid>`, and `agent` is `claude`.
- `orca plugin dev hook . agent.launch.before` with a command of the same shape returns `continue`, with the four flags added and the prompt still last. The event needs `workspaceKind` and `env`, or Orca refuses it as invalid.
- Not seen: a launch from workspace create.

## 2. A tracked session: partly pass

- Pass: the agent lists `orca-inbox` (tools `record` and `close`) beside the person's own MCP servers, so `--mcp-config` adds a server and does not replace the others.
- Pass: the session started cleanly with the multi-line guidance, and the agent's replies follow it.
- Pass: the person's own `UserPromptSubmit` hook still adds its text to each prompt (seen in the transcript as its own hook entry).
- Fail: the plugin's prompt hook added nothing to the transcript, because of the bug above. The `inbox:` text that the agent quoted came from a separate Claude Code inbox install that the person runs, not from this plugin.
- Seen: `inbox.view` counts only the agents of the focused workspace. Orca scopes `agents.list` to the active workspace, so every other agent is out of view.

## 3. Done means: partly pass

- Pass: two tracked agents in one workspace. Asked for a multiple-choice question, the agent called `record`. The row was saved at 18:26:13.9, 4.5 s before the turn's `done` (18:26:18.4). It shows under the correct section, with three choices and the recommendation marked. The row arrives through the tool, so it does not wait on the inbox model.
- Pass: `inbox.press` `answer` typed `Re "<question>": <option>` into the correct terminal at 18:28:42. The agent replied and closed the question with `close`, and the closed row reads "✓ … Auth.test.ts beside source".
- Seen, correct: the first press carried a stale `drawn` token and was held with "a turn ended since the row was drawn". It typed nothing.
- Fail (bug above): the agent's next reply asked a yes/no question in text only, and no row showed for it, because the transcript is never read. The 15-second time from `done` to a row that the inbox model adds was not measured.

## 4–6: not run

Blocked by the workspace-id bug:

- 4. A recorded finding under Issues and Opportunities, and a plan file under PLAN.
- 5. Panel shots with three agents, in light and dark at a narrow width.
- 6. A check of the `inbox.view` output shape, and the "not tracked" count for a `claude` typed into a plain shell.

## States not seen

- A row that the inbox model adds after a turn, and its time from `done`.
- A press label that moves from `sending` to sent.
- Findings, the plan, the no-tools note and the Claude-only note in the live panel.
- A launch from workspace create.
- Any panel shot.

# Second pass

Run: 2026-11-05, Orca 1.4.248, Claude Code 2.1.318, on the fix at `6856a79`. During the run, another commit (`74070af`, launch logging) landed and the worker restarted several times on folder changes. Four agents were launched from Orca's launcher into the same throwaway folder workspace, and one `claude` was typed into a plain shell there. The person also used Orca during the run, so focus moved away from the test workspace more than once. `inbox.view` covers only the focused workspace, so each read below was made right after a switch to a test terminal. Times are UTC.

## Bug: the inbox model is never logged in

Every inbox-model run fails with `Not logged in · Please run /login`, so no row comes from the model. Found in this pass, not fixed.

- The worker runs `claude -p` with `process.env` (`src/model.ts:72-74`). Orca starts the worker with only `HOME`, `PATH`, `TMPDIR` and its Electron and Node channel variables. `USER` is missing.
- Without `USER`, `claude` cannot find its login. With the worker's own variables, `claude -p` printed `Not logged in · Please run /login`. With the same variables plus `USER`, it answered `ok`.
- Effect: after three failures a turn is dropped and the panel shows "N turns not read" (`src/turns.ts:172-174`). The plugin log shows one failure line per try.

## Bug: the socket file can vanish after a worker restart

Seen once, cause not proven. After four worker starts within one minute (23:51:07 to 23:52:04), the socket folder was empty while the worker ran. `record`, `close` and the prompt hook then have no worker to reach. A run of `bin/prompt-hook.mjs` by hand printed nothing. `orca plugin restart` made the socket again.

- A likely cause: Node removes a Unix socket's file when its server closes. If the old worker closes after the new worker listens on the same path (`src/socket.ts:133`, `src/worker.ts:257-269`), the old worker removes the new worker's file.

## Bug: the panel does not reload on focus or untracked changes

The panel asks for `inbox.view` only at setup and on `inbox.changed` (`src/panel.tsx:206-208`). The worker posts `inbox.changed` only after a save (`src/turns.ts:114`). A focus change, a `claude` typed into a plain shell, and an agent that `agents.list` gives only after its launch save do not save anything.

- Evidence: `inbox.view` gave 3 sections and `untracked: 1`. Two shots of the open panel taken then both read "2 agents tracked" with no "not tracked" line.

## 3. Done means: partly pass

- Fail (bug above): an agent asked a multiple-choice question in its reply text only, with no tool call (turn end 23:48:03). No row came in 90 s. The log reads `turns: model failed for <turn>: Not logged in`. The time from `done` to a model row was not measured.
- Pass: the worker now reads the transcript. The session's saved `transcript` and `cwd` were set and the turn was queued for the model, where the first pass left them null.
- Pass: an agent called `mcp__orca-inbox__record` at 23:58:53.2 with a question. The row showed under Questions, with its two options and the recommendation, before the turn ended at 23:58:58.7.
- Pass: `inbox.press` `answer` with a fresh `drawn` answered `{ ok: true, label: "Sending…" }` in 0.8 s. The answer reached the correct terminal as `Re "<question>": No, leave it` (00:00:03.6). The label read "✓ No, leave it" 2.3 s after the press. The agent then called `mcp__orca-inbox__close` with the answer (00:00:09.9).

## 4. The plugin's prompt hook, findings and plan: pass

- Pass: the transcript has a `hook_success` entry for the plugin's command, `node …/bin/prompt-hook.mjs --socket … --session …`, with `inbox:` text on each prompt. The person's own inbox mod adds its own `inbox:` text under the hook name `prompt.submit`, so the two are told apart by hook name. On the first prompt the plugin printed the plan-file note. After the `record`, it printed the open items with their close ids.
- Pass: asked to leave a finding, the agent recorded an opportunity. It showed under "Opportunities · 1" with Do it, File issue, Reply and Dismiss, and "Issues · 0".
- Pass: asked for a three-step task, the agent wrote `.inbox/plans/<session>.md` as the plan note says. `inbox.view` gave `done: 2, total: 3`, the third step `current` and the task open. The panel drew "PLAN 2 of 3 steps", the progress bar, ✓ on two steps and ◐ on the third.
- Seen: in a session where the person's own inbox mod already listed a question, the agent would not record it again, because it saw a duplicate.

## 5. Three agents and shots: partly pass

- Pass: with three tracked agents and one plain-shell `claude` in the workspace, `inbox.view` gave three sections, newest first, and `untracked: 1`.
- Fail (panel bug above): the open panel still drew two agents and no "not tracked" line.
- Not done: light and dark shots. `orca plugin shot --theme dark` answered `themeApplied: false` because the Orca window was visible, so both files are the light theme. Shots at 320 px:
  - `second-pass-light-320.png`: the empty state, "2 agents tracked", "2 turns not read".
  - `second-pass-plan-320.png`: a question with its options, the plan open.
  - `second-pass-findings-320.png`: the opportunity, one closed question, the plan folded.
- Seen at 320 px: the row age "now" wraps into "no" and "w" on two lines, beside a question and a finding title.

## 6. Not tracked and restart: pass

- Pass: a `claude` typed into a plain shell in the workspace counted in `untracked` and got no section.
- Pass: `orca plugin restart local.agent-inbox` needs no approval. `inbox.view` before and after, with the same focus, differed only in a row's age ("3m" to "4m"). The question's closed row, the opportunity, the plan and `unread: 2` all stayed.

## Other things seen

- One launched agent's session id changed before its first turn. The launch passed `--session-id <A>`, but Claude Code's own record for that process gave a new id `<B>`, and the transcript is `<B>.jsonl` with a `SessionStart` of kind `startup`. The person had typed into that terminal. The plugin kept it as a tracked section under `<A>`, which never gets a transcript. The cause was not found. The other three launches kept their ids.
- One launched agent exited 21 s after launch, before any prompt. The cause was not found.

## States not seen (second pass)

- A row that the inbox model adds, and its time from `done`: blocked by the login bug.
- A dark-theme shot, and a narrow light shot of three sections.
- A press label "Waits for the agent" or "Not delivered".
- A finding press (Do it, File issue), and a `step` press.
- The no-tools note and the Claude-only note in the live panel.
- A launch from workspace create.

## Note for checks

`orca plugin check` and `orca plugin test` start the real worker on this machine (they set `ORCA_PLUGIN_TEST_ROOT`). Any side effect on a shared path, such as the socket, needs that guard (`src/worker.ts:373`). Before the guard, each check run deleted the live socket.

## Codex live check (T21) — 2026-11-06

Dev plugin from commit `51a4fe5`, Orca's Codex 0.166.0, Claude Code 2.1.319. Two Codex agents and one Claude agent started from Orca (`orca agent launch --surface terminal`) in one worktree.

| Check | Result |
|---|---|
| Launch hook tags each agent | Pass. Log: two `agent=codex … tagged=codex tools=yes`, one `agent=claude … tagged=new tools=yes`. |
| Codex asks to trust the prompt hook | Pass. "Hooks need review: 1 hook is new or changed" in each Codex agent; "Trust all and continue". |
| Each pane gets its own rows | Pass. Codex A: a question with "Tab (recommended)", "Pane". Codex B: one issue with Fix, File issue, Reply, Dismiss. Claude: a question with "Keep it (recommended)", "Rename". Three sections. |
| An answer press reaches the right Codex pane | Pass. `inbox.press` answer "Tab" on Codex A's row returned "Sending…"; Codex A replied "I took your answer as Tab and closed the Agent Inbox question"; Codex B's screen did not change; the row closed. |
| `codex resume <id>` typed in the pane after `/quit` | Not tracked. The typed command has none of the plugin's flags, so the agent used the person's own Codex `inbox` plugin, not `orca-inbox`. The spec now says so. |
| The person's own `notify` still runs | Not seen live: this Codex account sets no `notify`. Covered by `src/socket.test.ts` (notify script). |
| Panel before trust | Not seen: Codex reports no status while its trust dialog is open, so the panel showed only "1 agent not tracked" until the trust. |

States not seen: sub-agent threads, a press while Codex works, the panel in the dark theme, `/new` in a pane.

Found: a person who also has the inbox repo's Codex plugin installed gets both `inbox` and `orca-inbox` tools in an Orca Codex launch. The agents here used `orca-inbox` in every tracked turn.

## Row buttons and goal line (0.4.0) — 2026-11-09

Dev plugin from commit `5f7c9d0`, loaded from the dev folder and enabled with `orca plugin enable local.agent-inbox`. Buttons pressed by the person in the live panel; results as the person reported them.

| Check | Result |
|---|---|
| Goal line | Pass. The first `## ` heading of the session's plan file shows under the title. At `0e55b92` it was cut off with "…"; `5f7c9d0` wraps it, and the person confirmed the full text shows. |
| Open | Pass (reported). |
| Snooze | Pass (reported). |
| Hand off | Pass (reported). |
| Copy | Pass (reported). |
| Explain | Pass (reported). |

States not seen by the agent: each button's labels, the Snooze menu, a red error, a partial or uncertain hand-off, a snooze ending, the Open match when a folder and its worktree both hold the cwd, and which `hostId` Orca gives this machine (`'local'` or null).

## Sending hotfix (0.4.2) — pending

Not run yet. It runs after the plugin is installed. Plan: `docs/sending-hotfix-plan.md`, H4.

| Check | Result |
|---|---|
| After a reload, the mtime of `~/Library/Application Support/orca/plugins-data/local.agent-inbox/storage.json` changes, and `Buffer.byteLength(JSON.stringify(state))` is ≤ 200,000 | Pending. |
| Every terminal in `orca terminal list --json` that has an `agentIdentity` still has its binding in `state.terminals` | Pending. |
| An option press on a live question reads "✓ <option>", then the row closes after the turn | Pending. |
| For 10 minutes, the plugin log shows no new `value exceeds`, `press: save failed` or `turns: save failed` line | Pending. |
