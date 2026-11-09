# Row buttons: Explain, Open, Hand off, Snooze, Copy

Status: design agreed 2026-11-09. Build plan: [row-buttons-plan.md](row-buttons-plan.md).

## Goal

The Agent Inbox panel gets five row buttons. The panel draws no Discuss button and no "Ask why now" button.

| Button | Rows | What a press does |
|---|---|---|
| Explain | Every question, task and finding | Sends the explain message to the agent. The row reads "Explaining…", then "✓ Explained". |
| Open | Every row with a path | Opens the file in Orca's editor. The row reads "Opening x…", then "✓ Opened x" or the error in red. |
| Hand off | Every finding, and every task | Creates a child worktree and starts an agent there with the row's text as its prompt. |
| Snooze | Every row | Shows a menu: "1 hour" and "Tomorrow 9am". Hides the row in the panel until that time. |
| Copy | Every row | Copies a Markdown block to the clipboard. A row with a command copies only the command. |

## Explain

- Add `explain` to `PressInput.action`, `PressLabel.kind`, `LABEL_KINDS`, `DONE_TEXT` and the panel's `PENDING`.
- Map the press in `pressFor` (`src/turns.ts`), so that the ledger's explain path (`src/core/ledger.ts` `applyExchangeUpdate`) keeps the row open on the turn that explains it.
- Take the message text from the inbox mod's `messages.explain` and `messages.finding(…, 'explain')`, as the other press texts are taken.
- A second press reads "Explain again".

## Open

- The `record` tool gets an optional `path` on questions and tasks, as findings have now. `Item` gets `path: string | null`. `upgradeLedger` sets `null` on old items.
- A row shows Open when it has a path. An `open` help step also opens the file, and does not only copy the path.
- The worker calls `editor.open {workspaceId, path}`. Orca accepts only a path relative to the workspace and inside it, and only in the desktop app. The worker finds the workspace among the local host's `workspace.list` entries whose `path` contains `SessionState.cwd`, by whole path parts. It shows an error, and opens nothing, when no entry matches, when more than one matches, or when the list is `truncated`. It resolves the row's path against the cwd, makes it relative to the workspace, and shows "File is outside this workspace" in red when it is not inside. The manifest adds the `workspace:write` capability. `docs/spec.md` and the README list the new access.
- This changes text a model reads. Run the agent eval (`docs/agent-eval.md`) before and after, and compare the counts.

## Hand off

- The worker runs the `orca` CLI as a child process, as it runs `pbcopy` now. The CLI creates a child worktree of the row's workspace and starts the same agent kind there. The prompt is the row's text, built as `findingBody` builds it.
- One CLI call creates the worktree and starts the agent: `orca worktree create --name <name> --repo path:<cwd> --parent-worktree path:<cwd> --agent <kind> --prompt <text> --json`. `<cwd>` is `SessionState.cwd` and `<kind>` is `SessionState.agent`. No new capability is needed, because the call is not a host call. The plugin felix-lj-ct/orca-agent-inbox (MIT) runs the `orca` CLI from its worker the same way (`src/worker.ts:137-174`, `:362-374`): find the binary, run it with `execFile` and a timeout, and read the `{ok, error}` JSON.
- The row stays open and reads "✓ Handed off to <worktree>". The agent in this session sees no message.
- The worker runs one hand-off per row at a time. After "✓ Handed off", the row has no Hand off button.
- The row's saved press label is the receipt: it keeps the worktree name and the CLI's `operationId`.
- The worker reports "✓ Handed off" only when the result shows the worktree, the launched agent and the prompt delivered.
- When the CLI answers `{ok:false}` before it creates anything, the row shows the error in red and Hand off stays.
- When the worktree exists but the agent or prompt failed, the row reads "Worktree <name> made, agent not started" and Hand off goes away.
- On a timeout or a lost reply, the row reads "Hand off may have started: check worktree <name>" and Hand off goes away. The worker never retries by itself.
- Risk: the plugin API has no call to create a worktree. A later Orca release can block child processes for plugins. Then this button stops working, and the error shows on the row.

## Snooze

- The worker saves snoozes under their own storage key, `snoozes`, as `Record<"<sessionId>:<rowId>", number>` (the time each snooze ends). `SessionState` does not change, so the state version stays at 3. The worker drops ended snoozes when it reads the key.
- The panel hides a snoozed row until its time ends. A change to the item does not end the snooze. The agent still sees the row as open, and the `inbox:` text does not change.
- The panel redraws when the earliest snooze ends.
- "Tomorrow 9am" uses the local time zone.

## Copy

- The worker copies through `inbox.copy`. Add clipboard fallbacks for each platform, as felix-lj-ct/orca-agent-inbox does (`src/worker.ts:45-57`): `pbcopy` on macOS, `wl-copy`, then `xclip`, then `xsel` on Linux, and PowerShell `Set-Clipboard` on Windows. When no tool is found, the row shows the error in red. That code is MIT, "Copyright (c) 2026 Felix Li": keep its notice in a comment where we adapt it.
- A task with one or more `terminal` help steps copies their commands, one per line, and nothing else.
- Every other row copies:

  ```markdown
  **<title or ask>**

  <detail, when the row has one>

  File: `<path>`, when the row has one
  ```

- The row reads "✓ Copied".

## Order on a row

The new buttons go after the buttons a row has now and before Dismiss: Explain, Open, Copy, Hand off, Snooze.

## Out of scope

- Discuss and "Ask why now".
- The cero inbox repo and its four looks.
