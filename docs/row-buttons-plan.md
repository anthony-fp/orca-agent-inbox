# Row buttons: build plan

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-09) — HIGH. Do not implement this plan unchanged: T5 would break session routing and cannot satisfy its wake-on-change rule; T6 lacks safe handling of partial launches.**
>
> T5's v4 migration omits `src/socket.ts:134` and `:143`, which enable Claude session rebinding and moved-session lookup only when `version === 3`; after the upgrade, launch-session aliases stop following moved sessions and can record into the old ledger or return unknown-session errors. T6 treats an ambiguous launch failure as no side effects, but the `orca` CLI guide documents lost launch replies, `operationId` replay and workspaces kept after a partial launch; a 60 s `execFile` kill does not prove nothing was created, and with the row left open a second press can create more worktrees and agents. Snooze compares `item.at` with an unstored start, and `item.at` is creation time: `src/core/ledger.ts:745-750` changes options and recommendations, and `applyUpdate` adds helps, without updating it. Open's longest-path match ignores `hostId` and `truncated` from `workspace.list`, so it can select a workspace on another host.
>
> **Redesign required before build:**
> 1. **Add `src/socket.ts` to T5.** Update the `version === 3` guards at `:134` and `:143`, and run the moved-session routing cases against upgraded v3 state and native v4 state.
> 2. **Make Hand off safe against partial launches (T6).** Lock the row while a hand-off runs and after it, keep a saved receipt (worktree name, `operationId`), check `result.launch` and the prompt outcome before "✓ Handed off", and show an uncertain state, not "nothing changed", on a timeout or transport failure. Test concurrent presses and partial launches.
> 3. **Give Snooze a real change signal (T5).** Store the expiry plus a snapshot or revision of the snoozed row, and clear the snooze when its content changes. Do not change what `at` means. Test real option and help updates and a reload.
> 4. **Pick the workspace by identity, not path alone (T4).** Restrict to the local host or keep a host identity, fail on an ambiguous or `truncated` result, use path-component containment, and test identical paths on two hosts.
> 5. **Add a short dependency checklist to each task:** schema consumers, identity, and recovery behavior.
>
> **Status:** BLOCKED on T4, T5 and T6 redesign. T1, T2 and T3 are not blocked.
>
> **Resolved 2026-11-09:** items 1 and 3 by moving snoozes to their own storage key with no early return (user dropped that rule), so the state version stays 3; item 2 in T6; item 4 in T4. Item 5 is in T5. Not re-audited.
>
> **Done 2026-11-09:** T1 (Explain), T2 (Copy) and T3 (path on questions and tasks) shipped in 0.3.0. T4 (Open), T5 (Snooze), T6 (Hand off) and T8 (goal line) shipped in 0.4.0. The T7 live check in Orca is not done.

Spec: [row-buttons-spec.md](row-buttons-spec.md). Branch: `row-buttons`.

Gate after every task: `npm test`, `npm run typecheck` and `orca plugin validate .` pass. A failing gate blocks the next task. Each task is one commit.

## T1. Explain

- Files: `src/presses.ts` (`PressInput.action` :46, `findingText`, `DONE_TEXT` :151), `src/state.ts` (`PressLabel.kind` :68, `LABEL_KINDS` :119), `src/turns.ts` (`pressFor` :86), `src/panel.tsx` (`PENDING` :57, question rows :326, task rows :370, finding rows :431), `src/panel-views.ts`.
- Message text: copy `messages.explain` and `messages.finding(…, 'explain')` from the inbox mod (`hooks/presses.ts:871`, `:886` in anthony-fp/inbox).
- Tests:
  - `src/presses.test.ts`: an Explain press on a question, a task and a finding sends the explain text and reads "Explaining…", then "✓ Explained", then "Explain again". Pattern: `:318`.
  - `src/core/ledger.test.ts`: the turn after an Explain press keeps the row open. Pattern: `:271`.
  - `src/panel.test.tsx`: each row kind draws Explain in spec order. Pattern: `:334`.

## T2. Copy

- Files: new `src/clipboard.ts` (platform table, adapted from felix-lj-ct/orca-agent-inbox `src/worker.ts:44-57`, `:111-132`, with its MIT notice), `src/worker.ts` (`copyToClipboard` :63 uses it), `src/panel.tsx` (Copy button, Markdown block, commands only for a task with `terminal` helps).
- Tests:
  - New `src/clipboard.test.ts` with an injected `spawn`, as in `src/model.test.ts:17-44`: macOS uses `pbcopy`; Linux tries `wl-copy`, `xclip`, `xsel` in order; Windows uses PowerShell; no tool gives an error.
  - `src/panel.test.tsx`: a finding copies the Markdown block; a task with two commands copies two lines; the row reads "✓ Copied"; a failed copy shows red. Pattern: `:155`.

## T3. Open, part 1: `path` on questions and tasks

This task changes text a model reads.

- Files: `src/core/tools.ts` (`RECORD_SCHEMA` `path` :47, `recordItem` :108-142), `src/core/ledger.ts` (`addAgentItem` :795, model-made items :686 and :705, `upgradeItem` :75), `src/core/types.ts` (`Item.path`), `src/core/now.ts` (rows carry the full path), `bin/tools.json` (regenerate with `UPDATE_TOOLS=1 npm test`).
- Tests:
  - `src/core/tools.test.ts`: a recorded question and task keep `path`. Pattern: `:24`.
  - `src/core/ledger.test.ts`: an old saved item upgrades to `path: null`.
  - `src/socket.test.ts:414-420`: `bin/tools.json` matches.
- Eval: run the agent suite before and after, as `docs/agent-eval.md:7` says, with `--host orca`, 5 runs. No case may fall under the 75% bar. Save both results files and name them in the commit message.

## T4. Open, part 2: the button

- Audit fix: first confirm in `orca-host.d.ts` how `workspace.list` marks the local host. Keep local entries only, match by whole path parts, let the deepest local match win, and fail on no match, a tie at the deepest path (two local entries with the same path), or `truncated`.
- Files: `orca-plugin.json` (add `workspace:write`), `src/worker.ts` (new `inbox.openFile` handler: `workspace.list`, local-host match on `SessionState.cwd`, resolve and relativize, `editor.open`), `src/protocol.ts`, `src/panel.tsx` (Open button; an `open` help step opens instead of copying, :129-166), `src/panel-views.ts`.
- Tests:
  - `src/worker.test.ts` with `mockHost` results for `workspace.list` and `editor.open`: a path inside opens with the relative path; a path outside shows "File is outside this workspace" and makes no call; no match, two local entries with the same path and a `truncated` list each show an error and make no call; the same path on another host is skipped; a folder `/a` and a worktree `/a/wt` both holding `/a/wt/sub` open in `/a/wt`; `/a/b` does not match `/a/bc`. Pattern: `:815`.
  - `src/panel.test.tsx`: Open shows on rows with a path only; reads "Opening x…", then "✓ Opened x".

## T5. Snooze

- Audit fix: snoozes live under their own storage key, `snoozes`, so `SessionState` and the state version (3) do not change, and the `version === 3` guards in `src/socket.ts:134`, `:143` stay correct. A snooze ends only at its time.
- Files: `src/worker.ts` (`snoozes` key, keyed `<sessionId>:<rowId>`, ended entries dropped on read; `inbox.snooze` handler; view marks snoozed rows), `src/protocol.ts`, `src/panel.tsx` (menu with "1 hour" and "Tomorrow 9am", hide snoozed rows, one timer for the earliest end), `src/panel-views.ts`.
- Dependency check: `src/state.ts` unchanged; no state version change.
- Tests:
  - `src/worker.test.ts`: a snooze saves under `snoozes`, survives a worker restart, and is dropped after it ends.
  - `src/panel.test.tsx` with fake timers: the row hides and comes back after 1 hour. "Tomorrow 9am" at 23:30 and at 08:00 gives the right time.
  - `src/worker.test.ts`: the `inbox:` text the agent gets still lists a snoozed item.

## T6. Hand off

- Files: new `src/orca-cli.ts` (find the binary as felix-lj-ct does at `src/worker.ts:137-153`, `execFile` with a 60 s timeout, parse `{ok, result, error}`), `src/worker.ts` (`deps.orca`, `inbox.handoff` handler), `src/protocol.ts`, `src/panel.tsx` (Hand off on findings and tasks), `src/panel-views.ts`.
- Command: `orca worktree create --name <slug of title> --repo path:<cwd> --parent-worktree path:<cwd> --agent <SessionState.agent> --prompt <row text> --json`.
- First step of the task: run `orca worktree create --help` and one real `create` in a scratch repo, and record the result JSON shape here before code reads it. Remove that worktree after.
- Result shape, from one real `create --agent claude --prompt … --json` on 2026-11-09 (Orca CLI at `/Applications/Orca.app/Contents/Resources/bin/orca`):
  - Every reply is `{ id, ok, result | error, _meta: { runtimeId } }` on stdout. `ok: false` also exits 1.
  - Success, exit 0: `result.worktree` has `id` (`<repoId>::<path>`), `path`, `displayName` (the `--name`), `branch` (`refs/heads/<prefix>/<name>`) and `parentWorktreeId`. `result.launch` has `outcome: { kind: 'terminal' | 'structured', handle, paneKey }`, `receipt: { mode, detail }`, `prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }` and `operationId`. Orca's own hand-off guide (in the CLI) counts the prompt delivered when `prompt.outcome` is `handed-to-terminal` or `journaled`; the other values are `not-delivered` and `unconfirmed`.
  - Launch not confirmed, exit 1: `error: { code: 'agent_session_operation_unknown', message, data: { launchOutcome: 'unknown', retrySafe, operationId, recoveryCommand, nextSteps } }`. The first try gave this for a repo Orca did not know (nothing was made), and a retry with `--retry-launch` gave it again. The worker reads any `{ok:false}` with `launchOutcome` or `operationId` as "may have started", never as a clean error.
  - The scratch repo needed `orca repo add --path <repo>` first. Cleanup: `orca terminal close --terminal <launch.outcome.handle>`, then `orca worktree rm --worktree path:<path> --force`. The branch stays and needs `git branch -D`.
- Audit fix: one hand-off per row at a time (in-memory lock in the worker), the saved press label is the receipt (worktree name, `operationId`), and success needs the worktree, the launch and the prompt delivered. Outcomes follow the spec: clean `{ok:false}` → red, Hand off stays; worktree made but agent or prompt failed → "Worktree <name> made, agent not started"; timeout or lost reply → "Hand off may have started: check worktree <name>". In the last two and after success, Hand off goes away. No automatic retry.
- Tests:
  - New `src/orca-cli.test.ts` with an injected `execFile`: binary lookup order; `{ok:false}` becomes a clean error; a timeout becomes "uncertain", not an error.
  - `src/worker.test.ts` with a fake `deps.orca`: the arguments are right; "✓ Handed off to <name>" only when launch and prompt succeeded; each failure outcome gives its label; two presses at once start one hand-off; after any outcome but a clean error, the row has no Hand off; the receipt survives a reload; no text goes to the agent.
  - `src/panel.test.tsx`: Hand off shows on findings and tasks, not on questions.

## T7. Docs, release and live check

- Files: `README.md` (access table :33-40, including the `workspace:read` row :40; feature text), `docs/spec.md` (:21, :107-109), `package.json`, `package-lock.json`, `orca-plugin.json` (version 0.3.0), `src/panel.check.ts` (one scenario with all new buttons).
- Check: `orca plugin check .`, then a live session in Orca: press each button on each row kind, and record which states were not seen in `docs/live-check.md`.

## T8. Goal line

- Spec: [goal-line-spec.md](goal-line-spec.md).
- Files: `src/core/plan.ts` (`planGoal`: the first `## ` heading, beside `parsePlan`), `src/worker.ts` (`readPlan` keeps `goal` with the plan), `src/protocol.ts` (`InboxSection.goal`), `src/panel.tsx` (one muted line under the title that wraps, never truncated), `src/panel-views.ts`.
- Dependency check: schema consumers are the panel, `panel-views.ts` and the worker tests; no saved state changes. Identity: the goal is the session's, read from `planPath(cwd, sessionId)`. Recovery: the goal lives in memory only and is read again from the file after a restart. `planNote` does not change, so no text a model reads changes.
- Tests:
  - `src/core/plan.test.ts`: the first `## ` wins; `### ` and `#` do not count; no heading gives null; spaces trim.
  - `src/worker.test.ts`: the view carries the goal, and a changed plan file changes it.
  - `src/panel.test.tsx`: the line draws under the title, and nothing draws when the goal is null.
