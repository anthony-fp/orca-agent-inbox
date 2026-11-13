# Plan: 0.4.2 hotfix for rows stuck on "Sending…"

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-13) — HIGH. Do not implement unchanged: H1 can delete live routing, and H2–H3 still permit stuck or misleading delivery states.**
>
> H1 can evict sessions still used by running agents: an empty ledger and queue plus an old `touchedAt` do not establish inactivity, and eviction removes terminal/pane bindings, so later tool calls return 'unknown session' (`src/socket.ts:143-147`) and done events lose routing. On live data, 32 of the 35 eligible sessions keep terminal bindings (12 pane bindings). H2 catches only the save: `confirm` awaits `deps.read` without recovery (`src/presses.ts:286`), and the worker read calls `learn()`, which saves metadata (`src/worker.ts:242-255`); the same storage rejection kills the watcher with the label still `sending`, and H3's deadline never runs. H3's 10-minute deadline abandons answers legitimately queued behind a working agent (`src/presses.ts:292`, `src/presses.test.ts:164-173`), shows "Not delivered" for an accepted answer, and stops the late prompt from setting `turnId`, which `pressFor` needs (`src/turns.ts:88-90`).
>
> **Redesign required before build:**
> 1. **Protect live sessions in H1.** Never evict a session with terminal/pane bindings to a live terminal, active tracker work, or transitive launch aliases. Remeasure the savings on live data with those protections before you fix the 200,000-byte budget. Test: an old empty session whose agent later records an item.
> 2. **Make `confirm` survive read failures.** Handle `deps.read` and metadata-save failures with bounded retry and a final uncertain state. Test: the initial save and a later confirmation read both reject.
> 3. **Replace H3's hard stop.** Show "unconfirmed" instead of "Not delivered" after the deadline, and keep transcript reconciliation so a late prompt still sets `turnId` and closes the answer. Test: a queued prompt that arrives after 10 minutes.
> 4. **Coupling with [state-size-plan.md](state-size-plan.md).** Keep H1's retention rule compatible with part B's per-session keys, so part B does not have to undo it.
>
> **Status:** BLOCKED on fixes 1–3.
>
> **---- revised 2026-11-13: items 1-4 addressed in H1-H3 ----**
>
> **---- refresh 2026-11-13 (Codex re-audit) — HIGH. Do not implement unchanged. ----**
> ~~2. Make `confirm` survive read failures.~~ Resolved in the revised H2.
>
> Startup pruning still deletes protected live sessions: `worker.ts:323-325` calls `tracker.prune()`, which removes sessions older than 7 days by items, queue and `touchedAt` only (`turns.ts:373-390`), before `save()` can protect them; a live agent then gets 'unknown session' (`socket.ts:147`), and `bind()`/`bindClaude()` do not recreate a missing launch session. Late reconciliation in `drain()` matches text without respecting `label.from` (`presses.ts:338`, `state.ts:74-75`), so a repeated press can attach to an older identical queued prompt, and `pressFor()` closes the question as answered (`turns.ts:173-176`) for a send that never arrived.
>
> **Redesign required before build:**
> 1. **Use one eviction rule for startup and save.** `prune()` must call the same `evictable()` and evict nothing while liveness is unknown. Test: worker start with an old live-bound session, and with an old session holding only an open finding.
> 2. **Drop the `drain()` text match.** Keep the existing offset-bounded `confirm()` matcher, which starts at `label.from`, running past the 10-minute mark at a slower poll; the label shows "Sent, not confirmed" meanwhile, and a later match still sets `turnId`. Test: an identical queued prompt from before the press, then a repeat press that never arrives, stays unconfirmed.
> 3. **Keep `MAX_CLOSED` at 5.** Lowering it changes retained history, reopening and duplicate suppression; the protected eviction alone reaches the budget.
> 4. **Do not build part-B abstractions here.** Share only the retention rule that save and startup pruning need.
>
> **Status:** BLOCKED on fixes 1–2.
>
> **---- revised again 2026-11-13: refresh items 1-4 addressed ----**
>
> **---- refresh 2 2026-11-13 (Codex third audit) — HIGH. Do not implement unchanged. ----**
> Refresh items 1–4 resolved in structure. No over-scope found.
>
> Focused-workspace results cannot establish global terminal death: `agents.list` covers only the focused workspace (`orca-host.d.ts:133-136`), and `statuses` is empty after reload (`worker.ts:295`) and only gains entries (`worker.ts:206,543`). So a quiet live agent in another workspace can be evicted, and a closed terminal stays "live" forever, so H3's stop never fires. Slow 10 s confirmation can miss the answer-closing window: the tracker drains a turn every 1 s (`turns.ts:223-248`) and checks `pressFor` only before it processes the turn (`turns.ts:173-176`), so a `turnId` set later never closes the question. Hand-off has the same stranded-label bug: `handOff` sets a running receipt before it awaits storage (`worker.ts:634-636`); a rejected save leaves "Handing off…" in memory, and every retry is rejected as 'Handed off already' (`worker.ts:628`).
>
> **Redesign required before build:**
> 1. **Take liveness from `orca terminal list --json`.** With no `--worktree`, it lists live terminals in every workspace (checked 2026-11-13: the output includes `expense/sandperch`). Treat a terminal as dead only when a successful global list omits it; on CLI failure, `live` is null and nothing is evicted or stopped. Use the same list for the H3 stop. Tests: a quiet agent in another workspace after reload survives; a closed terminal stops the watcher.
> 2. **Keep the 1 s confirmation poll after 10 minutes.** Only the label changes to "Sent, not confirmed". Test: a late prompt whose whole turn drains between two polls still closes the question.
> 3. **Restore the hand-off label when its first save rejects.** Test: no worktree starts, and a second hand-off is allowed.
>
> **Status:** BLOCKED on fixes 1–3.
>
> **---- revised 3 2026-11-13: refresh 2 items 1-3 addressed ----**
>
> **---- refresh 3 2026-11-13 (Codex fourth audit) — HIGH. Do not implement unchanged. ----**
> ~~Refresh 2 items 1 and 3.~~ Resolved in plan (`src/orca-cli.ts:74-82`; `src/worker.ts:644-648`). Item 2 incomplete. No over-scope found.
>
> Confirmation during an active drain still leaves the answer open: `drain` reads `pressFor` once (`src/turns.ts:173`), then awaits `deps.model` (`:180`); the offset advances only when settle commits (`:145-150,183-184`). If `confirm` matches during that await, the prompt is not before the offset, so the H3 fallback does not close it, and a confirmed answer stays open permanently. A cached terminal list can stop confirmation for a newly opened terminal: H1 allows a terminal opened after the last 60 s snapshot to be absent from `live`, and H3 stops the watcher on that absence before `turnId` is recorded (`src/turns.ts:88-90,173-176`). Restart handle continuity is unverified; test restart and rebinding before destructive eviction.
>
> **Orchestrator decision after four rounds: cut H3 from this hotfix.** Every high finding since round 1 is in H3's confirm/drain reconciliation. That race exists in today's code and does not cause the stuck "Sending…" (the full storage does). `confirm()` stays as it is now: no deadline, no stop, no late-close fallback. The race is tracked as a separate finding.
>
> **Remaining before build:** remove H3 and its tests; add the restart-rebinding test to H1.
>
> **Status:** BLOCKED until H3 is removed.
>
> **---- revised 4 2026-11-13: H3 removed, restart test added ----**
>
> **---- refresh 4 2026-11-13 (Codex fifth audit) — APPROVE. No high or critical findings in H1–H4. ----**
>
> **Status:** Not blocked. Build H1–H4 in order. The confirm/drain race follows in [confirm-race-plan.md](confirm-race-plan.md) after H4.

Branch: `anthony-fp/fix-stuck-sending-items`. Per-session storage (part B of [state-size-plan.md](state-size-plan.md)) is not in this plan.

Gate after every task: `npm test`, `npm run typecheck` and `orca plugin validate .` pass. A failing gate blocks the next task. Each task is one commit.

## Problem

Orca rejects a storage value over 262144 bytes. On 2026-11-13 the live `state` value is 261,750 bytes, and `storage.json` has not changed since 05:28. The sum of all 93 sessions grows. 0.4.1 limits only the closed records in each session (`src/turns.ts:94-98`).

A press puts its `sending` label in memory (`src/turns.ts:368`). The save fails, and `await saving` throws (`src/presses.ts:345`) after the text is already typed (`src/presses.ts:340`). `confirm()` never starts (`src/presses.ts:354`). A failed save inside `read()` → `learn()` (`src/worker.ts:242-255`) ends `confirm()` the same way. The panel shows the worker's "Sending…" label instead of its own error (`src/panel.tsx:430`). Hand off has the same fault: its first save sets "Handing off…" (`src/worker.ts:636`), and a retry then gets 'Handed off already' (`src/worker.ts:628`).

Test helper for every task: `rejectingStorage(limit)` in `src/test-clock.ts`. It is a fake `get`/`set` that throws `value exceeds <limit> bytes` when `Buffer.byteLength(JSON.stringify(v)) > limit`.

---

## H1. One retention rule for startup and save

- Files: `src/turns.ts` (`save()` `:127-134`, `prune()` `:373-392`), `src/worker.ts` (start `:321-324`, `deps.orca` `:718`).
- Liveness: `live` is the set of `handle` values from `orca terminal list` with no `--worktree`, which lists terminals in every workspace. The worker runs it through `runOrca(['terminal', 'list'])` (`src/orca-cli.ts:74-82`), which adds `--json` and never throws. The worker runs it at start and then every 60 s.
  - `live` is null when the reply is not `ok`, or when `result.truncated` is true. A null `live` evicts nothing.
  - A terminal opened since the last list is not in `live`. Its session is still kept by the 24 h rule: `track` sets `touchedAt` to now for a new session and for a known one (`src/turns.ts:334-339`).
- Add one function, `evictable(state, live, now)`. It returns session ids, oldest `touchedAt` first, and returns none when `live` is null. A session is kept when any of these is true:
  - It has an open item or finding, or a queued turn.
  - It was touched in the last 24 h.
  - A terminal or pane binding points at it, and that terminal is in `live`.
  - It has a poll or drain running (`src/turns.ts:120-122`).
  - It is linked through `moved`, in either direction and transitively, to a kept session.
- `prune()` drops the `evictable` sessions that are older than `PRUNE_MS`. The start call (`src/worker.ts:321-324`) runs after the first list, or drops nothing when that list failed.
- `save()` drops `evictable` sessions while the copy is over `BUDGET = 200_000` bytes. The budget is best effort: when only protected sessions are left, the save still runs. The unknown-version guard stays first (`src/turns.ts:128`). `MAX_CLOSED` stays at 5.
- Both callers remove a dropped session's terminals, panes and `moved` entries with the filters that `prune()` has (`src/turns.ts:384-386`).
- Measured on the stale `storage.json`, with `live` from `orca terminal list --json` (5 terminals, `truncated: false`): 261,750 → 197,549 bytes, with 51 sessions that can go. The bindings made since 05:28 are only in memory, and the 24 h rule keeps those sessions.
- Tests in `src/turns.test.ts`:
  - With `rejectingStorage(262144)`, a 270 KB state with old unbound sessions saves at ≤ 200,000 bytes.
  - An old empty session bound to a live terminal stays, and its agent then records an item.
  - An old session that holds only an open finding stays.
  - A `moved` chain A→B→C, where C is kept, keeps A and B.
  - With `live` null (the list failed or is truncated), neither `save()` nor `prune()` drops a session.
- Tests in `src/worker.test.ts`, with a fake `deps.orca` for `terminal list`:
  - After a reload, a quiet agent in another workspace is in the list and has no status. Its old empty session survives start and the next save.
  - An old live-bound session and an old session that holds only an open finding both survive start.
  - Restart: a new worker loads a state where an old empty session is bound to terminal T, and T is in the list. No status event has come yet. A save over the budget keeps the session. Then a status event for T and a `prompt-start` for the session both find it, and no 'unknown session' is returned (`src/socket.ts:147`).
  - A terminal that opened after the last list gets `track` for an old session. A save over the budget keeps that session.

## H2. Press, confirm and hand-off survive failed saves and reads

- Files: `src/presses.ts` (`:284-303`, `:339-355`), `src/worker.ts` (`read` `:249-256`, `handOff` `:623-664`), `src/panel.tsx` (`Local` `:34`, `press` `:126-129`, `rowState` `:425-431`).
- Press: catch a rejected `saving`, log `press: save failed for <id>`, and go on to `confirm()`.
- `read()`: catch and log a failed `learn()`. The bytes still return.
- `confirm()`: catch a failed `deps.read`, log it, and treat it as no bytes. The loop then goes on as it does today when `bytes` is null (`src/presses.ts:286-300`). No new label.
- Hand off: when the first save (`src/worker.ts:636`) rejects, put back the label from before the press (`before`, `src/worker.ts:632`), as the error path does (`src/worker.ts:645-650`). Return `{ ok: false }` and run no `worktree create`.
- Panel: add `error: boolean` to `Local`. A local label with `error: true` wins over `row.label` in `rowState`.
- Tests:
  - `src/presses.test.ts`: the press save rejects, then one confirm read rejects. After the prompt shows, the label is `✓ Yes`.
  - `src/worker.test.ts`: with `rejectingStorage` near the limit, `inbox.press` and then `inbox.view` show `✓ <option>` after the prompt shows.
  - `src/worker.test.ts`: the first hand-off save rejects. `deps.orca` gets no call, the row has no "Handing off…" label, and a second `inbox.handoff` after the storage recovers runs `worktree create`.
  - `src/panel.test.tsx`: `inbox.press` throws, and the view says "Sending…". The row reads `Not sent: <message>`.

## H3. Tell the panel after a failed write too

- Files: `src/turns.ts` (`save()` `:131-132`).
- Change: `writes.then(changed, e => { log('turns: save failed: …'); changed() })`. Today the panel reloads only after a write that worked, or after an agent status change (`src/worker.ts:190-200`).
- Test in `src/turns.test.ts`: with a storage whose `set` always rejects, one `edit` calls `changed` once and logs one `turns: save failed` line.

## H4. Release 0.4.2 and check it live

- Files: `package.json`, `package-lock.json` (two places), `orca-plugin.json`, as in d52241d. `docs/live-check.md`: a new section `## Sending hotfix (0.4.2) — <date>` after `:144`.
- Commits, as in d52241d and e98f74e: `Release 0.4.2: rows no longer stick on "Sending…"`, then `Record the 0.4.2 live check`.
- Live check:
  - Reload the plugin. The mtime of `~/Library/Application Support/orca/plugins-data/local.agent-inbox/storage.json` changes, and `Buffer.byteLength(JSON.stringify(state))` is ≤ 200,000.
  - Every terminal in `orca terminal list --json` that has an `agentIdentity` still has its binding in `state.terminals`.
  - Press an option on a live question. The row reads "✓ <option>", then closes after the turn.
  - For 10 minutes, the plugin log shows no new `value exceeds`, `press: save failed` or `turns: save failed` line.

---

## Out of scope

- Part B of `state-size-plan.md`, and any abstraction for it.
- A timeout on `terminal.sendText` (`src/worker.ts:315`).
- Changes to `PRUNE_MS` or `MAX_CLOSED`.
- The confirm/drain race. `drain` reads `pressFor` once, before it awaits the model (`src/turns.ts:173`, `:180`). If `confirm()` sets `turnId` after that read, the answered question stays open. This race is in today's code, and it does not cause the stuck "Sending…". It is tracked as a separate finding.
- The `confirm()` loop with no deadline. It ends only on a match, or on `done` plus 10 s (`src/presses.ts:290-300`). A status that is never `done` keeps the label at `sending`.

<!-- Audit findings are added below by /audit-plan. -->
