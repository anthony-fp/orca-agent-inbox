# Chat sessions: build plan

> **⛔ RETIRED 2026-11-17.** Not built. Orca 1.4.261 gives a plugin no way to send text into a native chat, so chat sessions could be tracked but not answered. Release 0.4.5 shows a note instead. The partial T2–T7 work is saved as `.git/chat-sessions-wip.patch` in the main checkout (not in the repo). Revisit when Orca adds a plugin API to send into a chat and fires `agent.launch.before` for chat launches.

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-17) — HIGH. Three gaps; all three are now fixed in the tasks they affect.**
>
> Codex found: T3 treated `agents.list` as a complete live inventory, but it covers only the focused workspace, so live chats elsewhere could be evicted. T4's rebinding through `bindClaude` gave an unknown target `wholeLinesEnd` and skipped a turn in progress. T1's probe plugin had a different name from the shipped one, so the recorded tool names would be wrong, and the eval did not exercise SessionStart guidance.
>
> **Applied before build:**
> 1. **Use `orca worktree ps --json` for liveness.** T3; T1 checks folder workspaces.
> 2. **Give rebinding targets the `since` boundary.** T4, with `/clear` tests.
> 3. **Name the probe `orca-agent-inbox`; eval the `ORCA_PLUGIN` host.** T1, T9.
>
> **Status:** Not blocked. T1 (live check) still gates T2 onward.

Spec: [chat-sessions-spec.md](chat-sessions-spec.md). Branch: `anthony-fp/native-chat-session-tracking`. Release: 0.5.0.

Gate after every task: `npm test`, `npm run typecheck` and `orca plugin validate .` pass. A failing gate blocks the next task. Commit once at the end (user decision, 2026-11-17). In each task, write the tests first and see them fail.

**T1 is a gate for the whole plan. If T1 fails, stop: do not start T2.** Layer 2 depends on a user `--plugin-dir` beside Orca's own, and Layer 1 alone is not worth a release without a decision from the user.

## Points the code makes harder than the spec assumes

1. **"No `--session`" already means Codex.** `bin/prompt-hook.mjs:37` and `bin/mcp-server.mjs:42-50` take an empty `--session` as a Codex launch. The generated plugin passes a new `--seat` flag instead (T9). Seat mode never takes the Codex path.
2. **Plugin MCP tools have other names.** Claude Code prefixes the tools of a plugin's MCP server with the plugin name. The guidance and inbox text name `mcp__orca-inbox__record` and `mcp__orca-inbox__close` (`src/core/model-text.ts:297-298`). T1 records the real names, and T9 adds a host with them. This changes text a model reads, so T9 runs the agent eval.
3. **A 60 s hold does not fit a 5 s client.** The hook and MCP clients give up after 5 s (`bin/ask.mjs:6`). The worker cannot hold a request open for 60 s. It answers at once and holds only a *pending record* of the seat (T8).
4. **"Connected" must survive a restart.** SessionStart fires once per conversation. A seat flag in memory is lost on each worker restart, and the banner then shows for every chat. The plan keeps the flag on the session: `SessionState.tools` (`src/state.ts:43`) is false until the handshake. It is saved already (`src/state.ts:170`).
5. **`agents.list` gives no seat.** It has no `paneKey`, so first sight there tracks the session with no seat, as `track(null, …)` does today (`src/turns.ts:423-424`). The next status event binds the seat.
6. **An idle new chat can miss the 60 s window.** SessionStart fires when the chat opens. If Orca sends no status event and no `agents.list` entry until the first prompt, a chat left idle for over 60 s loses its handshake and shows the banner. T8 asks `agents.list` at once for each pending seat. T12 checks this case live. If it fails, the user decides between a longer hold and a different signal.
7. **Terminal launches already carry a `--plugin-dir`.** Orca adds its own agent-view plugin dir (`docs/live-check.md:19`). `tagLaunch` must match the inbox path exactly, not any `--plugin-dir` (T10).
8. **Known effect of a rollback.** 0.4.4 drops `since` on load (`src/state.ts:155-177`). A chat session whose `since` is not resolved then reads from offset 0 and replays its history. Resolved sessions are not affected.

## T1. Live check: a user `--plugin-dir` beside Orca's own (manual, user)

The user runs this. No code changes.

1. Make a throwaway Claude plugin with no space in its path:
   - `~/inbox-probe/.claude-plugin/plugin.json`: `{"name":"orca-agent-inbox"}` (the shipped plugin name, so the recorded tool names are the real ones)
   - `~/inbox-probe/hooks/hooks.json`: one `SessionStart` command hook, command
     `sh -c 'cat > "$HOME/inbox-probe/input.json"; env | grep -E "^(ORCA_|CLAUDE_CODE_SESSION_ID)" > "$HOME/inbox-probe/env.txt"; echo "The probe word is PELICAN."'`
   - `~/inbox-probe/.mcp.json`: server `orca-inbox`, command `node`, args `["<repo>/bin/mcp-server.mjs", "--socket", "/nonexistent", "--session", "probe"]`. `tools/list` reads `bin/tools.json` and needs no socket (`bin/mcp-server.mjs:15`, `:34-35`).
2. Print the exact paste text: `echo "--plugin-dir $HOME/inbox-probe"`. Paste that output into Orca → Settings → Agents → Claude → **Arguments**. Orca does not expand `~` or `$HOME`, so paste the printed absolute path.
3. Start a new Claude chat in Orca's native chat, in a throwaway folder workspace. Type: `What is the probe word? Then list the exact names of your tools that end in __record.`
4. Run `ps -ax -o args | grep -- '--plugin-dir' | grep -v grep`.
5. Open a new Claude terminal tab and ask the same question.

**Pass**, all of:
- The chat starts with no argument error, and it answers PELICAN.
- The chat's `claude` process line in step 4 has two `--plugin-dir` values: Orca's native-chat-visuals dir and `~/inbox-probe`.
- `env.txt` has `ORCA_AGENT_SESSION_ID=claude_…` and `CLAUDE_CODE_SESSION_ID`. `input.json` has `session_id`, `transcript_path` and `source: "startup"`.
- The terminal tab also answers PELICAN.

**Record** in `docs/live-check.md`: the exact `ORCA_AGENT_SESSION_ID` form (T2's `SEAT` pattern), the exact namespaced `__record` and `__close` tool names (T9), and the Orca and Claude Code versions. Also run `orca worktree ps --json` while the chat is open, and record whether the chat appears with a `structured-agent-session-` paneKey (T3's liveness source). Repeat with a chat in a folder (non-git) workspace.

**Fail**: the chat does not start, Orca reports a repeated `--plugin-dir`, the chat loses Orca's visuals plugin dir, or there is no PELICAN. Stop the plan and report to the user.

Cleanup: clear the Arguments setting, delete `~/inbox-probe`.

## T2. State: seats and `since`

- Files: `src/state.ts` (`SessionState` :18-53 gains `since: number | null`; `emptySession` :110 sets it null; `upgradeSession` :155-177 keeps a finite number, else null; the `terminals` comment :92 says the key is a seat; new exported `SEAT` pattern for `term_…` and the `claude_…` form T1 recorded).
- Rule: `since !== null` means the offset is not resolved yet. Only T5's resolution clears it.
- No version change: the field is additive, so `newerVersion` (`src/state.ts:189-190`) and the `version === 3` checks (`src/socket.ts:139`, `:148`) stay.
- `upgradeState` (`src/state.ts:197-233`) already keeps any key in `terminals` (`:200-203`). The tests prove it for a chat seat.
- Tests, in `src/turns.test.ts` `describe('upgradeState')` (:401):
  - A saved session with `since: 123` and `offset: 0` upgrades with `since: 123` (open item a).
  - A session with no `since`, or a non-number `since`, upgrades with `since: null`.
  - A `claude_x` seat in `terminals` and its `moved` alias survive the upgrade.

## T3. Retention: the live set

Before discovery, so no discovered chat session is evicted.

- Files: `src/worker.ts` (`Agent` type :69 gains `sessionId?: string | null`, `paneKey?: string`, `stateStartedAt?: number`; `listTerminals` :307-311 also runs `orca worktree ps --json` through the same CLI helper, and `live` becomes the terminal handles plus every chat seat read from a `structured-agent-session-<seat>:` paneKey in any worktree; when either call fails, `live` is null), `src/turns.ts` (`evictable` :100-117 keeps a session whose seat binding is in `live`).
- Audit fix: `agents.list` covers only the focused workspace (`docs/live-check.md:30`, `src/worker.test.ts:835`), so it MUST NOT decide liveness. `orca worktree ps --json` lists agents in every worktree, chat sessions included. T1 checks that a chat in a folder (non-git) workspace also appears there. If it does not, a chat session with a seat is kept while its last status event is under 7 days old.
- Tests:
  - `src/turns.test.ts` `describe('retention')` (:635): an idle chat session (no rows, old `touchedAt`) whose seat is in `live`, in a workspace other than the focused one, survives budget eviction and the 7-day prune. The same session not in `live` is evicted. Pattern: `:665`.
  - `src/worker.test.ts`: `orca worktree ps` fails, so `live` is null and a save over budget evicts nothing that round. Startup prune keeps a live chat outside the focused workspace.

## T4. Chat discovery: first sight, seat binding, `done` by session

**Build order: T5 before T4** (plan round 2). `track` defaults a new offset to 0 (`src/turns.ts:449`) and `poll` ignores `since` (`src/turns.ts:331-339`), so discovery without the boundary would queue history. Build and gate T5 first, then T4.

- Files:
  - `src/worker.ts`: the status handler (:201-224) today returns when there is no `terminalId` (:205). For a Claude event with no `terminalId`, it reads the seat from `paneKey` `structured-agent-session-<seat>:…` and adds the seat to a confirmed-seat set (used by T8). Then:
    - unknown session: `track(seat, sessionId, { since, tools: false })`. `since` = `stateStartedAt` when the state is `working`, else now.
    - seat bound to another session (`/clear`, `/resume` in a chat): `bindClaude(old, sessionId, undefined, undefined, seat)` (:449-475). Its handle check (:460) uses `SEAT`. Audit fix: `bindClaude` gives an unknown target `wholeLinesEnd` (:462-468), which skips a turn already in progress. For a chat seat, an unknown target gets the same `since` rule as first sight instead; a known target keeps its offset.
    - state `done`: `tracker.doneSession(sessionId)`.
  - `src/worker.ts`: the listing tick (:313) and the view's `agents.list` (:530) track each unknown Claude entry with `terminalId: null` as `track(null, sessionId, { since, tools: false })`. Codex chat entries are skipped (out of scope).
  - `src/turns.ts`: `track` (:426-453) takes `since` for a new session only. `done` (:497-503) resolves its session and calls a new `doneSession(sessionId)` with the same body.
- Tests, in `src/worker.test.ts`, with `mockHost` status events and `agents.list` (pattern: `:148`):
  - A `working` status event for an unknown chat saves the seat binding, `since` = `stateStartedAt`, `tools: false`.
  - A `waiting` event saves `since` = the clock's now.
  - An `agents.list` entry with `terminalId: null` saves the session with no seat. A later status event binds the seat.
  - A status event with a new `sessionId` on a bound seat rebinds the seat and sets `moved[old] = new`.
  - `/clear` then a `working` event whose transcript already holds the new prompt: that turn is read on `done`. The same when the new transcript appears one poll later.
  - A `done` event for a chat session polls its transcript.
  - A chat discovered after two completed turns, then one new turn: only the new turn is queued.
  - A Codex chat entry is not tracked.

## T5. The `since` boundary, poll retry and startup polling

- Files:
  - `src/transcript.ts`: new `offsetAt(bytes, since)` beside `wholeLinesEnd` (:199). It gives the start byte of the first line where `isTurnStart` (:74) holds and the timestamp is at or after `since`, else `wholeLinesEnd(bytes)`.
  - `src/turns.ts` `poll` (:320-350): before it reads a turn, a session with `since !== null` resolves when bytes exist: `offset = offsetAt(...)`, `ledger.turn = promptsBefore(bytes, offset)` (as `adopt` does, `src/worker.ts:497-499`), `since = null`, then save. With no bytes, it keeps `since` and reads nothing. A resolved offset is moved only by turn reading.
  - `src/turns.ts` `start` (:402-416): also polls each Claude session with `since !== null`. Chat seats live in `terminals`, so the loop at :413 covers bound chat sessions.
  - `src/worker.ts` listing tick (:313): starts a poll for each session with `since !== null`, so the lookup retries on every tick, not only on status events.
- Tests:
  - `src/transcript.test.ts`: a prompt at exactly `since` counts; an earlier prompt does not; no prompt after `since` gives the end; a half-written last line is never the boundary. Pattern: `:91`.
  - `src/turns.test.ts`: no transcript on the first poll keeps `since`; the transcript appears and the next poll resolves it; a restart with a saved `since` resolves the same offset; an idle session's earlier turns are never queued; a `working` session with `since` before its prompt queues that turn; after resolution, a later poll does not move the offset back.

## T6. Panel and protocol: chat sections send nothing

- Files:
  - `src/protocol.ts`: `InboxSection.terminalId` (:8) becomes optional.
  - `src/presses.ts`: `PressInput.terminalId` (:43) becomes optional. A press with no `terminalId` whose action sends text is refused `invalid` before any label is saved (before `sendOf`, :337). `sendCheck` (:251-253) also refuses it.
  - `src/worker.ts` view (:542-592): an entry with `terminalId: null` and a known `sessionId` (through `moved` too) becomes a section with no `terminalId`. It is not in `others`.
  - `src/panel.tsx`: with no `terminalId`, hide every action whose press sends text: options, reply, steps, Fix, File issue, Explain, finding Done (it sends: `src/presses.ts:330`) and plan actions. Keep item Done, Dismiss, Copy, Open, Snooze and Hand off. Hide the "No tools" note (:781-786) for a chat section: T11's banner covers it.
- Tests:
  - `src/panel.test.tsx`: a chat section draws its rows and status with no sending button; Dismiss and Copy stay. Pattern: `:53`.
  - `src/presses.test.ts` (`describe('presses')`, :90): an `answer` with no `terminalId` is refused and sends nothing; a `dismiss` with no `terminalId` closes the row.
  - `src/worker.test.ts`: the view has a chat section with no `terminalId`, and `others` does not list it.

## T7. The generated Claude plugin

- Path: `~/.orca-agent-inbox/claude-plugin`. Reasons: macOS cleans `$TMPDIR`, where the socket and bin copies live today (`src/socket.ts:26-30`, `:39-62`); an installed plugin's folder can be replaced or read-only (`src/socket.ts:33`); `~/Library/Application Support/…` has a space, which the user must then quote in Arguments. The worker knows the home folder (`src/worker.ts:755`).
- Files: `src/socket.ts` (new `writeClaudePlugin(dir, socketPath)` beside `stableBinPaths`; it calls `stableBinPaths(join(dir, '.mcp.json'))` for the 0700 folder and `bin/` copies, then writes, by temp file and rename, `.claude-plugin/plugin.json` (`{"name":"orca-agent-inbox"}`), `.mcp.json` (`orca-inbox`: `node <dir>/bin/mcp-server.mjs --socket <socket> --seat`) and `hooks/hooks.json` (`SessionStart`: `… prompt-hook.mjs --socket <socket> --seat --event session-start`; `UserPromptSubmit`: `… prompt-hook.mjs --socket <socket> --seat`)), `src/worker.ts` (`WorkerDeps.tools` :39 gains `pluginDir`; the start at :121 writes the plugin; `liveTools` :748-750 sets the path).
- Tests, in `src/socket.test.ts` beside the `stableBinPaths` tests (:362-376):
  - The three files parse and name the copies in the plugin's own `bin/`, not the `$TMPDIR` copies.
  - A second write replaces the files and leaves no `.tmp` file.
  - A folder another user owns throws, as `stableBinPaths` does.

## T8. Socket: `session-start`, seat requests and admission

**From T2 review:** `src/socket.ts:93` and `src/worker.ts:460` still use their own `term_` patterns. Switch both to `SEAT` (`src/state.ts:9-10`) in this task, or chat seats are rejected.

- Files:
  - `src/socket.ts`: `Request` (:62-66) adds `{ type: 'session-start'; seat; sessionId; transcript?; source }` and an optional `seat` on `prompt-start`, `inbox-text`, `record` and `close`; `TYPES` (:104) adds `session-start`. `AnswerDeps` (:71) gains `resolveSeat(seat, sessionId, transcript?, cwd?)` (the current session, or `unconfirmed`) and `sessionStart(...)`. A seat request uses the seat's session: a `prompt-start` whose `session_id` differs from the seat's binding rebinds first, as `bindClaude` does today (:138-146).
  - `src/worker.ts`: admission. A `term_` seat is confirmed when `state.terminals` or `live` has it. A chat seat is confirmed when a status event named it (T4), or when an `agents.list` entry with `terminalId: null` has the same `sessionId`. An unconfirmed seat gets a pending record `{ seat, sessionId, transcript, source, at }`, and the worker calls `agents.list` at once. Each status event and listing tick checks pending records; a record older than 60 s is dropped.
  - On admission, the worker applies the handshake **before** T4's first sight, so `startup` gives offset 0. A session it does not know: `startup` → offset 0, `resume` / `clear` → `wholeLinesEnd` of the transcript; `since: null`; `tools: true`. A known session: `tools: true` only; the offset never moves.
- Timing rule (open item b): `session-start` never waits for admission. It answers at once with `guidanceText` for every request it records. The listener stamps each request when it arrives, before `await ready` (`src/worker.ts:518`). If more than 4 s passed (the client gives up at 5 s, `bin/ask.mjs:6`), the worker records nothing and answers an error. So a session is connected only if its hook could print the guidance.
- `record` and `close` from an unconfirmed seat are refused at once (the agent sees "not available"), and the seat gets a pending record. Nothing is held open.
- Tests, in `src/worker.test.ts` with the fake clock and a socket answerer:
  - An unconfirmed chat seat's handshake answers with guidance at once; the session is not connected. A status event 30 s later admits it: offset 0, `tools: true`.
  - No confirmation for 60 s drops the record. A status event at 61 s gives T4's first sight with `tools: false`.
  - A restart with no status event: `agents.list` with the same `sessionId` admits the seat.
  - `ready` delayed 6 s: the handshake records nothing and answers an error. The session stays unconnected.
  - A `compact` handshake for a known session leaves its offset.
  - A `record` from a seat that is never confirmed is refused, and the ledger is unchanged after 60 s (background run).
  - `prompt-start` with the seat bound to A and `session_id` B rebinds to B and sets `moved[A] = B`; a `record` with the seat lands on B.
  - A `term_` seat in `state.terminals` is confirmed at once.

## T9. Hook and MCP scripts in seat mode

This task changes text a model reads.

- Files:
  - `bin/ask.mjs` (`readArgs` :8-16): reads `--seat` and `--event`.
  - `bin/prompt-hook.mjs`: with `--seat`, the seat is `ORCA_TERMINAL_HANDLE` or `ORCA_AGENT_SESSION_ID`, and the Codex test (:37) is false. `--event session-start` sends `session-start` with `session_id`, `transcript_path` and `source` from stdin and prints the answer's text. Otherwise it sends `prompt-start` and `inbox-text` (:55, :58) with `seat` and `session_id`. No answer: no output, exit 0.
  - `bin/mcp-server.mjs` (:42-50): with `--seat`, it sends `{ seat, sessionId: CLAUDE_CODE_SESSION_ID }` and never takes the Codex path.
  - `src/core/model-text.ts`: new `ORCA_PLUGIN` host, `{ ...ORCA }` with the tool names T1 recorded (beside `ORCA` :292). `src/socket.ts` :156 uses it for seat requests, and `session-start` returns `guidanceText(ORCA_PLUGIN)`.
- Tests, in `src/socket.test.ts`:
  - `describe('bin/prompt-hook.mjs')` (:560): seat mode sends the seat and `session_id`; `--event session-start` prints the guidance; no worker gives no output and exit 0; a seat-mode hook with no `ORCA_PANE_KEY` is not Codex.
  - `describe('bin/mcp-server.mjs')` (:486): seat mode sends the seat and `CLAUDE_CODE_SESSION_ID`; a refused call returns "not available".
  - The guidance and inbox text for a seat request name the plugin tool names.
- Eval: run the agent suite before and after, as `docs/agent-eval.md:7` says, with `--host orca` and again with the new `ORCA_PLUGIN` host (guidance delivered as SessionStart context, not `--append-system-prompt`; extend the harness for this), 5 runs each. No case may fall under the 75% bar.

## T10. `tagLaunch`: the inbox plugin dir

- Files: `src/launch.ts` (`LaunchTools` :20-24 gains `pluginDir`; the Claude loop :207-222 notes `--plugin-dir` equal to `tools.pluginDir`, either form, as `splitInline` reads it; then :237-239 adds only `--session-id` (or keeps `--resume`) and returns `tools: true`), `src/worker.ts` (`untaggedReason` :104-116 reads the command the same way).
- Rule: only an exact match counts. Orca's own `--plugin-dir` (point 7) does not. Codex is unchanged.
- Tests, in `src/launch.test.ts` (pattern: `:24`):
  - The inbox `--plugin-dir` gives `--session-id` and no `--mcp-config`, `--settings` or `--append-system-prompt`, with `tools: true`.
  - The same with `--resume <uuid>`: nothing added.
  - Orca's own `--plugin-dir` alone: behaviour unchanged.
  - The inbox dir plus a user `--mcp-config`: still `tools: true`.
  - Codex: unchanged.

## T11. Banner

- Files: `src/protocol.ts` (`InboxView` :55-63 gains `connect: { paste: string } | null`), `src/worker.ts` (view: `connect` is set when any chat section has `tools: false`; `paste` is `--plugin-dir <absolute pluginDir>`), `src/panel.tsx` (one banner at the top: "Enable inbox for chat sessions", the paste text, a Copy button through `inbox.copy`, and the lines "Applies to chats started after the change." and "If Arguments already has a `--plugin-dir`, replace it: only one fits.").
- Tests:
  - `src/worker.test.ts`: a chat session with `tools: false` sets `connect`; after its handshake, `connect` is null; terminal sections never set it.
  - `src/panel.test.tsx`: the banner draws the paste text, and Copy sends it.

## T12. Docs, release and live check

- Files: `README.md` (chat sessions and the paste), `docs/spec.md`, `package.json`, `package-lock.json`, `orca-plugin.json` (version 0.5.0), `src/panel.check.ts` (one scenario with a chat section and the banner), `docs/live-check.md` (results).
- Check: `orca plugin check .`, then live in Orca, one line each for the spec's "Done when" (`docs/chat-sessions-spec.md:136-146`):
  - With no paste, a new chat with two earlier turns, then one new turn: the section appears, its status follows the chat, and only the new turn's rows show.
  - Paste the banner text. A new chat: the banner goes, the agent calls `record`, a row appears, and a later turn closes it from the inbox text.
  - A new chat left idle for 2 minutes before its first prompt: the banner stays away (point 6).
  - A terminal session with the paste: `ps` shows one inbox MCP server; the transcript shows one inbox prompt hook output per prompt.
  - Generate a commit message in Orca: no row, no section.
  - An idle chat survives a save over budget (watch the log for an eviction line).
  - `/clear` in a chat: the next `record` lands on the new conversation.
  - From T3 review: open a chat in a folder (non-git) workspace and run `orca worktree ps --json`. If the chat is missing, build T3's fallback (keep a seated chat while its last status event is under 7 days old) before release.
