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
