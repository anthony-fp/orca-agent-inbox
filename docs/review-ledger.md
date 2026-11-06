# Spec review ledger

## Round 1 — 2026-11-05
- [fixed] Matching a transcript by the time of its last write can attach another agent's conversation → the launch hook now tags each agent: `--session-id` for Claude Code, and the launch time with a `session_meta` filter for Codex. An agent with no tag is not tracked. spec.md "How it works" step 1, and Risks 1.
- [fixed] An answer can go to a terminal at a shell prompt, a busy agent or an open dialog → send only when `mainAgent.state` is `done`. Otherwise hold the answer. Show "✓ Answered" only after the transcript shows the answer. spec.md step 6.
- [fixed] The exchange left out `activity`, `screen`, `turn` and `press`, which `buildPrompt` and `applyExchangeUpdate` take → the Exchange adapter is now defined field by field. spec.md step 3.
- [fixed] A `done` event can come with no `terminalId`, a null `workspaceId`, child agents or an interrupted turn → eligibility rules added. The path now comes from `workspace.list`. spec.md step 2.
- [fixed] The `terminal:read` fallback had no capability → fallback removed. An unmatched agent is not tracked.

## Round 2 — 2026-11-05
- Verified real: the Exchange fields, the eligibility rules, and the removed `terminal:read` fallback.
- [fixed] Orca reserves `ORCA_*` env names, so the Codex tag was refused (`plugin-hook-payloads.js:43-50`) → the hook changes nothing for Codex. A rollout is assigned only when exactly one Codex launch waits in that folder; otherwise none is tracked. spec.md step 1.
- [fixed] A `done` before the transcript is written lost the turn → the turn is pending in storage, read again each second for 15 s, complete only when the reply exists and the file stops growing for 2 s. The offset moves only on a complete turn. spec.md step 2.
- [fixed] `--resume` with a name, a picker or `--fork-session`, and the old `--continue` rewrite, gave wrong ids → only `--resume <uuid>` with no fork is tracked. The plugin no longer adds `--fork-session`. spec.md step 1.
- Codex said the remaining issues can be resolved during implementation.

## Round 3 — 2026-11-05
- Verified real: all Round 2 fixes. Claude's flags support the stated `--session-id` and `--resume` rules.
- [fixed] A pending turn with no reply could block every later turn → a later prompt closes it as `incomplete` and the offset moves on. spec.md step 2.
- [fixed] A Codex launch that never makes a rollout could block later launches → a waiting launch expires on terminal close, on replacement, or after 60 s. spec.md step 1.
- Converged. Codex: "Further review rounds unlikely justify cost." Both findings were small rules; no schema or interface left open.

## Round 4 (findings section) — 2026-11-05
- Verified real: the CLI flags, the `mcp__orca-inbox__*` tool names, and that `systemText` reads only `band`.
- [fixed] The inbox's `show` tool adds a file to the Files tab (`hooks/files.ts:11-23`); it does not list items → no `show`. A `UserPromptSubmit` hook added with `--settings` prints `inboxText(ORCA)` beside each prompt, as the skill does. spec "The agent's tools" step 1.
- [fixed] A 5 s tool timeout conflicted with waiting for a 45 s model run → tool calls never wait; the model's update applies to the ledger at commit time; each call is stamped with the current turn. Step 4.
- [fixed] `record` returns no id (`hooks/tools.ts:108-141`) → kept as in the skill; the id reaches the agent in the inbox text beside its next prompt. Step 3.

## Round 5 (findings section) — 2026-11-05
- Verified real: the `--settings` prompt hook and the no-id `record` answer.
- [fixed] Tool calls could carry the previous turn, because the ledger's turn moves only at a model commit → the prompt hook sends `prompt-start` first; the worker raises the active turn and saves it before it answers. Step 4.
- Converged: the only finding was an interface detail, now specified with its tests. Codex said the rest can be settled during implementation.

## Code round 1 (Codex support, 9ee221b..d6d2811) — 2026-11-05
- Verified sound: launch quoting and stable hook command, 120 s timeout keeps the turn, notify sends ids only.
- [fixed] A notify or done starts a rollout read; only `task_complete` queues a Codex turn. The old pairing fields drop on upgrade (`src/state.ts:133`, `src/turns.ts:231`, `src/turns.ts:351`; restart regression `src/turns.test.ts:454`).
- [fixed] A different thread rebinds a pane only with a later rollout start time from `session_meta` or its file name (`src/worker.ts:297`, `src/worker.ts:323`; late old signals test `src/worker.test.ts:158`).
- [fixed] Codex sends require a seen prompt hook in that terminal's pane; untrusted rows offer Copy and the trust instruction. A press prompt from another thread makes the hook exit 2 (`src/presses.ts:206`, `src/worker.ts:448`, `src/panel.tsx:574`, `src/socket.ts:143`, `bin/prompt-hook.mjs:59`; tests `src/presses.test.ts:81`, `src/socket.test.ts:521`).
- [fixed] The MCP server inherits `CODEX_HOME`; both clients use it directly, and the parent lookup script is removed. The hook command remains stable (`src/launch.ts:127`, `bin/mcp-server.mjs:47`, `bin/prompt-hook.mjs:44`; `src/launch.test.ts:278`).

## Code round 2 — 2026-11-05
- Verified real: all round 1 fixes; no duplicate-turn path found; restart between notify and read, and Codex outside Orca (`~/.codex`), raise nothing.
- [fixed] A tracked launch clears the terminal's old Codex pane binding; status keeps a Claude session or waits for the new Codex thread (`src/turns.ts:260`, `src/worker.ts:135`, `src/worker.ts:145`, `src/worker.test.ts:135`, `src/worker.test.ts:149`).
- [fixed] A typed prompt matches another thread's press only while it is sending and under 10 s old; undelivered and older presses do not block (`src/socket.ts:142`, `src/socket.test.ts:149`).
- [fixed] A live prompt hook or tool call can rebind without rollout times, while a notify still needs a later start (`src/worker.ts:336`, `src/worker.test.ts:215`).

## Code round 3 — 2026-11-05
- Verified real: round 2 fixes (`src/turns.ts:260`, `src/socket.ts:142`, `src/worker.ts:336`).
- [fixed] Every terminal launch clears its old Codex pane binding; a skipped launch cannot send an old row (`src/worker.ts:118`, `src/turns.ts:255`, `src/worker.test.ts:168`, `src/worker.test.ts:195`).
- [fixed] Pane launch times survive state upgrade; old rollouts cannot rebind after relaunch, and binds run in pane order with a post-await check (`src/state.ts:90`, `src/turns.ts:262`, `src/worker.ts:330`, `src/worker.ts:358`, `src/worker.ts:382`, `src/worker.test.ts:186`, `src/worker.test.ts:221`, `src/worker.test.ts:242`, `src/turns.test.ts:372`).
- [fixed] An interrupted Codex turn reaches the model with an empty reply before the next complete turn (`src/turns.ts:231`, `src/turns.test.ts:452`).
- Converged: the reviewer said another broad round is not worth more than these targeted fixes and the live check (T21), and that no external interface changes. These three are fixed with tests and then checked live in T21; no round 4.

## Release round 1 (v0.1.1..8e29174, v0.2.1) — 2026-11-06
- [fixed] Prune dropped a launch session's alias after 7 days while its switched-to session was live, so tool calls with the launch id failed → alias kept while its target lives, src/turns.ts prune; test "prune keeps an alias…"
- [fixed] A new launch in a terminal kept the old Claude binding (clearPane returned early with no pane key), so a press could reach the new process → clearPane drops the terminal binding on every launch, src/turns.ts clearPane; test "a new launch … ends its old Claude binding"
- Reviewer: Codex flags, main-thread binding, queued-turn survival, old state loading and held labels are sound.

## Release round 2 — 2026-11-06
- [fixed] Round 1's alias fix was not real: on restart upgradeState drops an alias whose launch session is gone, and bindClaude needs the launch session → prune now keeps a launch session while its alias target lives (src/turns.ts prune); test checks the alias across a restart.
- [fixed] An older launch still reading its transcript could bind over a newer launch in the same terminal → per-terminal launch generation, checked before track (src/worker.ts launch hook); overlap test.
- Reviewer: no further material issue in Codex, script-path or press paths; both fixes are targeted edits, no broad round needed.

## Release round 3 — 2026-11-06
- Reviewer: both round 2 fixes are real (direct alias across restart, overlapping launches).
- [fixed] Prune lost an alias chain A→B→C when it visited A before keeping B → prune repeats the alias pass until nothing changes (src/turns.ts prune); restart test with a live chain and a cycle with no live session.
- Converged: reviewer says a fourth broad round costs more than the remaining risk; this was the one targeted fix left.

## Security review (v0.1.1..HEAD) — 2026-11-06
- No high-confidence vulnerabilities. Traced: socket and fixed script folder (owner and symlink refused, 0700), launch quoting, hook scripts, presses, transcript paths, model calls, panel text.
- [fixed] Needs verification: ESC, Ctrl-C and other control characters an agent puts in row text reached terminal.sendText → oneLine drops them and turns tabs into spaces (src/presses.ts oneLine); test.
