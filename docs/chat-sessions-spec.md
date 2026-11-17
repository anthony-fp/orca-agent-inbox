# Spec: track sessions launched from Orca's native chat

> **⛔ RETIRED 2026-11-17.** Not built. Orca 1.4.261 gives a plugin no way to send text into a native chat, so chat sessions could be tracked but not answered. Release 0.4.5 shows a note instead. The partial T2–T7 work is saved as `.git/chat-sessions-wip.patch` in the main checkout (not in the repo). Revisit when Orca adds a plugin API to send into a chat and fires `agent.launch.before` for chat launches.

Status: draft r2, 2026-11-17. Target: Orca 1.4.261 and later. Ships as an Orca plugin only.

## Problem

Orca's native chat launches Claude as a headless `stream-json` process, not in a terminal.
The plugin learns about a session only through `agent.launch.before`, and Orca fires that
hook only on the terminal spawn paths. A chat session therefore gets no `--session-id`,
no MCP server, and no prompt hook. Every later step keys on a `term_` handle
(`src/socket.ts:93`, `src/worker.ts:204-205`, `src/worker.ts:552`), so the panel never
shows the session.

## What Orca 1.4.261 gives a plugin

| Need | Available | Source |
|---|---|---|
| Status of chat sessions | Yes. `agent.status.changed` fires with `sessionId` = Claude UUID, no `terminalId` | app `main/index.js:3164`, `4470` |
| List chat sessions | Yes. `agents.list` returns `terminalId: null`, `sessionId` = Claude UUID | app `main/index.js:3164` |
| Transcript | Yes. `~/.claude/projects/*/<sessionId>.jsonl` | `src/worker.ts:228-241` |
| Inject launch args | No plugin hook. The user's Claude "Arguments" setting reaches chat AND terminal launches | app `shared/agent-launch/choices/agent-launch-profile.js:14-15`, `61-70` |
| Send text into a chat | No | app `shared/plugins/workers/plugin-host-api.js:144-148` |

Orca's chat arg parser keeps `--plugin-dir <path>` and rejects a repeated flag. Claude
accepts `--plugin-dir` more than once (`claude --help`), so a user `--plugin-dir` can sit
beside Orca's own native-chat-visuals plugin. The plan MUST verify this live.

## Design

### Session identity

- **Seat.** Today `terminals` maps a `term_` handle to the current Claude session
  (`src/state.ts:92`). This becomes a map from a *seat* to the current session. A seat is
  either a `term_` handle or a chat's Orca id `claude_<…>`. The chat seat comes from
  `ORCA_AGENT_SESSION_ID` in hooks and MCP children, and from the status `paneKey`
  `structured-agent-session-<seat>:…`. Conversation switches (`/clear`, `/resume`) rebind
  the seat and set `moved` aliases with the existing `bindClaude` path
  (`src/worker.ts:449-475`), for terminal and chat seats alike.
- **Session.** Turn state stays keyed on the Claude UUID in `state.sessions`.
  No terminal handle is invented for a chat.
- **Admission.** A seat is tracked only after Orca confirms it. A terminal seat is
  confirmed by a live terminal handle. A chat seat is confirmed by either a status event
  whose `paneKey` is `structured-agent-session-<seat>:…`, or an `agents.list` entry with
  `terminalId: null` whose `sessionId` equals the Claude session the handshake or MCP call
  reported. `agents.list` carries no `paneKey`, so the second path covers a worker restart
  with no new status event. A SessionStart
  handshake or MCP call from an unconfirmed seat is held as pending for 60 seconds, then
  dropped. This keeps Orca's background Claude runs out of the panel, even when the user's
  args stop Orca from disabling their hooks (app `claude-background-run-isolation.js:40-45`).
- **MCP identity.** The MCP server and hooks send their seat. The worker resolves the seat
  to the current session, so tool calls after `/clear` land on the new conversation.

### Layer 1: track with no setup

1. **Transcript boundary is a time, saved at first sight.** When the worker first sees a
   chat session, it saves `since`:
   - state `working`: `since` = the state's `stateStartedAt` (from `agents.list` or the
     status event), so the turn in progress counts.
   - any other state: `since` = the time of first sight. Earlier turns are history.
   Until the transcript exists, the session holds `since` with no byte offset, and the
   worker retries the lookup on every poll, not only on status events. When found, the
   offset = the start byte of the first user turn whose timestamp is at or after `since`,
   or the transcript end if there is none. `since` is saved with the session, so a
   restart resolves it the same way. Once an offset exists, only turn reading moves it.
2. **Turns.** On `done` the worker reads the turn from the transcript by `sessionId`
   (today it requires a terminal, `src/turns.ts:497-503`). Startup polling also covers
   chat sessions.
3. **Panel.** The section protocol makes `terminalId` optional (`src/protocol.ts:8`).
   A chat section shows status and rows, and hides every sending action: options, Fix,
   Explain, plan actions (`src/panel.tsx:113`, `src/presses.ts:252`).
4. **Retention.** The live set for both budget eviction and the 7-day prune is the live
   terminal handles plus the `sessionId`s that `agents.list` returns
   (`src/turns.ts:55-59`, `100-117`). If `agents.list` fails, nothing is evicted that round.

### Layer 2: one-time setup gives chat agents the inbox tools

1. **Generated Claude plugin.** The worker writes a Claude Code plugin directory to a
   stable per-user path (the plan picks it; `$TMPDIR` is cleaned by macOS, so it is not
   enough on its own). The directory holds:
   - `.mcp.json`: the existing `bin/mcp-server.mjs` with `--socket <path>` and no
     `--session`.
   - `hooks/hooks.json`: `SessionStart` and `UserPromptSubmit`, both running scripts
     that read `session_id` and `transcript_path` from hook input.
2. **The paste.** The user pastes `--plugin-dir <that path>` into Orca → Settings →
   Agents → Claude → **Arguments**. No `--settings`: a user `--settings` makes Orca drop
   its fast-mode pin.
3. **SessionStart handshake.** The hook sends `session-start {sessionId, transcriptPath,
   source}` to the socket. The worker:
   - marks the seat connected (this drives the banner),
   - for a session the worker does not know yet, sets the boundary: `startup` →
     offset 0; `resume` / `clear` → the transcript end. For a known session it never
     moves the offset, so compaction mid-turn loses nothing,
   - returns the inbox guidance (`guidanceText`) as `additionalContext`. This replaces
     `--append-system-prompt`, which Orca blocks for chat.
   If the worker is not reachable, the hook exits 0 with no output. The session falls
   back to Layer 1.
4. **UserPromptSubmit.** Same requests as today (`prompt-start`, `inbox-text`,
   `src/socket.ts:62-197`). The hook sends its seat (`ORCA_TERMINAL_HANDLE` or
   `ORCA_AGENT_SESSION_ID`) and the hook input's `session_id`. When the two disagree with
   the seat's binding, the worker rebinds the seat first, as `launchSession` does today
   (`src/socket.ts:138-146`). This keeps the dynamic
   inbox text that lets the agent close the rows it recorded (`src/core/ledger.ts:653-688`).
   `prompt-start` sets the turn start, the same as for terminal sessions.
5. **MCP server.** With no `--session`, it sends its seat plus `CLAUDE_CODE_SESSION_ID`
   (both present in MCP children; checked live). The worker resolves the seat to the
   current session and rejects an unconfirmed seat, so background runs record nothing.

### Terminal launches when the plugin dir is present

The Arguments setting reaches terminal launches too. `tagLaunch` (`src/launch.ts:174-242`)
today treats any `--mcp-config` as a clash and drops all tool flags. New rule, Claude only:

- Inbox `--plugin-dir` present: add `--session-id` (or keep `--resume`) only. Add no
  `--mcp-config`, `--settings`, or `--append-system-prompt`. Record `tools: true`.
  The generated plugin gives the same MCP server, prompt hook, and guidance.
- Absent: behaviour unchanged.
- Codex: unchanged.

### Banner

While any tracked chat session has no SessionStart handshake, the panel top shows one
banner: "Enable inbox for chat sessions", the exact paste text, and a copy button.
The banner text says the setting applies to chats started after the change.

## Known side effects

- If the user already has a `--plugin-dir` in Arguments, Orca's parser throws on a second
  one. The banner then says to replace it, because only one fits.
- Plugins load with `--plugin-dir` for terminal Claude launches too. That is intended.

## Out of scope

- Reply buttons for chat sessions. They need an Orca API for sending text into a chat.
- Codex chat sessions. Only Claude is covered here.

## Done when

- A chat session appears in the panel with no setup. Its status follows the chat, and
  history from before discovery is not replayed.
- After the paste, a new chat session sends the handshake, the banner disappears, the agent
  calls `record`, a row appears, and the agent later closes it from the inbox text.
- A terminal session with the paste in place has exactly one inbox MCP server and one
  prompt hook.
- A background run (for example, generating a commit message) records nothing.
- An idle live chat session survives budget eviction.
- `npm test` and `npm run typecheck` pass.
