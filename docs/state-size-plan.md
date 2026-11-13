# Plan: keep the stored state under Orca's 256 KiB value limit

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-10) — HIGH. Do not ship this plan unchanged: A can discard required finding links, and B introduces routing, rollback, and partial-write hazards.**
>
> A's keep rule follows the finding link backwards: `Item` has no `askedAs` (`src/core/types.ts:10-31`); the link lives on `closedFindings` and `reopenAskedFindings` searches it by the closing item's id (`src/core/ledger.ts:519-523`). A at `MAX_CLOSED = 12` saves only ~23 KB on live data (≈238–254 KB left), above the 200 KB target. B's v4 breaks `socket.ts:134,143`, which require `version === 3` to use `moved` — the "socket keeps working" claim is false. One oversized session (unbounded queued transcript text, `src/transcript.ts:138,164-167`, persisted at `src/turns.ts:207-210`) can block the index write. Rolling back after migration loads an empty inbox (`src/state.ts:192-200`) and its next save overwrites the index. An old index does not give a consistent snapshot: `track` changes session metadata with routing (`src/turns.ts:308-331`).
>
> **Redesign required before build:**
> 1. **Fix A's keep rule.** Keep a closed finding's own id when its `askedAs` equals an open item id. Test: prune past 12 findings, dismiss the linked question, the finding reopens.
> 2. **Measure A before choosing N.** Live: cap 12 saves 23 KB, cap 5 saves 75 KB, cap 3 saves 100 KB. `told` holds 19 KB more.
> 3. **Ship an unknown-version guard in A.** A loader that sees a version it does not know must refuse to save, not overwrite.
> 4. **Separate the persisted index version from the runtime shape**, or update `socket.ts:125-143`. Add socket tests for migrated aliases and a conversation switch.
> 5. **Bound one session's size** (cap or chunk transcript/queue text) and stop one session's failed write from blocking the index. Test with a fake that enforces 262144 bytes.
> 6. **Keep a migration backup** of the v3 value and test rollback before B overwrites `state`.
> 7. **Use revision keys or design mixed-generation recovery** for B; inject a failure at every write during a rebind.
>
> **Status:** A not blocked after fixes 1–3. B BLOCKED on fixes 4–7.
>
> **---- revised 2026-11-13: part B redone against 0.4.3; items 4–7 resolved in "How items 4–7 are resolved" ----**
>
> **⚠️ AUDIT OF REVISED B, round 1 (Codex, 2026-11-13) — needs-attention, 3 HIGH. Item 4 resolved. Items 5–7 NOT resolved:**
> - **RB-1 (item 5) — addressed in revision 2026-11-13 (pending audit round 2): a failed or skipped session write must reject its durability caller.** `handOff()` awaits `tracker.edit()` and launches the worktree unless it rejects (`src/worker.ts:674-685`); socket `record` acks through `edit()` (`src/socket.ts:170-179`). "Log and continue" loses receipts and open rows. Fix: keep writing other keys, but reject each caller whose session did not persist; bound session content without dropping open items or receipts. Test: rejected and oversized receipt writes, assert no worktree launches.
> - **RB-2 (item 6) — resolved by user decision 2026-11-13 (see Decisions): the 0.4.3 guard blocks writes, not tracking.** `readOnly` only makes `save()` resolve (`src/turns.ts:172-173`); prompt-start still adopts sessions (`src/socket.ts:151-153`, `src/worker.ts:490-500`) and `handOff()` launches on a no-op save. "Tracks nothing new" is false. Needs a user decision on the rollback procedure.
> - **RB-3 (item 7 / capacity) — addressed in revision 2026-11-13 (pending audit round 2): eviction cannot enforce the `storage.keys()` 1024-entry cap.** `evictable()` protects sessions with open items or queued turns and returns nothing when live terminals are unknown (`src/turns.ts:68-85`); `keys()` has no pagination (`.orca/types/orca-services/index.d.ts:94`). Fix: a hard admission limit with headroom for `state`, `state.v3`, orphans and failed deletes; refuse new durable sessions visibly before the cap. Test: more than 1024 small protected sessions.
>
> **⚠️ AUDIT OF REVISED B, round 2 (Codex, 2026-11-13) — 3 HIGH:**
> - **RB2-1 — addressed 2026-11-13, pending audit round 3: failed deletes defeat admission.** An evicted key whose delete fails still holds a slot. Fix in item 8: `track` admits only after the delete lands.
> - **RB2-2 — addressed 2026-11-13, pending audit round 3: an unreadable key must never be deleted.** Fix in item 8 and B3: `unreadable` and `pendingDelete` are two sets; only `pendingDelete` is deleted.
> - **RB2-3 — addressed 2026-11-13, pending audit round 3: a rebind can leave a stale alias.** `bindClaude` saves `track`, `learn` and `move` as three saves (`src/worker.ts:468-470`), and load drops a `moved` entry whose session has no key (`src/turns.ts:95`). Fix in item 7: one `rebind()` change and one save, with the index as the commit point.
>
> **⚠️ AUDIT OF REVISED B, round 3 (Codex, 2026-11-13) — 3 HIGH:**
> - **RB3-1 — addressed 2026-11-13, pending audit round 4: a pending delete can erase a readmitted session.** Fix in item 8: an id in `pendingDelete` tracks only after its delete lands.
> - **RB3-2 — addressed 2026-11-13, pending audit round 4: admission does not enforce the total byte limit.** Orca allows 5 MiB in total (`PLUGIN_STORAGE_TOTAL_MAX_BYTES`, `/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/plugins/workers/plugin-host-api-storage-schemas.js:15`). Fix in item 8: `BUDGET` is an admission limit, `TOTAL_MAX` guards every session write, and a failed admission is undone.
> - **RB3-3 — addressed 2026-11-13, pending audit round 4: the index can pass 256 KiB by itself.** `paneLaunches` (`src/turns.ts:360-363`) and `pendingCodex` (`src/turns.ts:473-481`) only grow, and `without()` keeps them (`src/turns.ts:88-96`). Fix in item 9: both fields are capped.
>
> **⛔ PLAN B STOPPED (2026-11-13).** Audit round 4 (design review) left RB3-2 and RB3-3 open and found a new HIGH (INDEX_MAX rejects tracking without evicting stale bindings). Per the user's rule, B stops after round 4 with a HIGH. Do not build B. Each round added limits that the next round broke; a future attempt needs a simpler storage design, not more limits.

## Problem

The plugin saves its whole state as one storage key, `state` (`src/state.ts:7`). Orca rejects a value over 262144 bytes. The live value is 277,468 bytes, so every `storage.set` at `src/turns.ts:120` fails. Since 2026-11-09 18:19, the plugin saves no state. The log shows the failures as `socket:`, `done:`, `turns:` and `launch: could not track`.

Two things make the value grow:

1. `ledger.closed` (145 KB live) never shrinks. `pruneClosed` (`src/core/ledger.ts:561`) exists, but no code calls it. Each `Closed` record holds a full copy of its item (`src/core/ledger.ts:449-453`).
2. All 79 sessions share one value, so the limit applies to their sum.

## Fix

- **A.** Prune closed records on every save. This brings the value back under the limit.
- **B.** Store each session under its own key. This removes the shared limit.

A ships first and stands alone. Do not start B until A is green and checked live.

---

## A. Prune closed records

### A1. Call `pruneClosed` on every save

- Files: `src/turns.ts` (`save()`, `:118-123`), `src/core/ledger.ts` (add a `keepIds(ledger, presses)` helper next to `pruneClosed`).
- In `save()`, before the JSON copy, run `pruneClosed(session.ledger, keep)` on every session. `keep` holds:
  - the id of every closed finding whose `askedAs` equals the id of an open item in `ledger.items`, so `reopenAskedFindings` (`src/core/ledger.ts:519-523`) still finds the link (audit fix 1)
  - every id that has a live `presses` label
- Trim `session.told.closed` to the ids that remain in `ledger.closed` (`src/core/model-text.ts:509` sets `told.closed`).
- Set `MAX_CLOSED = 5` (`src/core/ledger.ts:31`), the user's choice of 2026-11-10. The panel shows 3 per kind (`src/core/now.ts:9`). Live data: this saves about 75 KB, which leaves about 202 KB.
- Known effect: the panel's closed count (`total`, `src/panel.tsx:764`) drops to 5 at most. An ask closed more than 5 records ago can be asked again (`repeatsClosed`, `src/core/ledger.ts:420-429`).
- Tests:
  - `src/core/ledger.test.ts`: `pruneClosed` keeps the newest 5, and it keeps an older record whose id is in `keep`.
  - `src/turns.test.ts`: a session with 20 closed records saves 5. Prune past 5 closed findings, dismiss the open question that a finding links to through `askedAs`, and the finding reopens.

### A1b. Refuse to overwrite an unknown version (audit fix 3)

- Files: `src/state.ts` (`upgradeState`, `:192-229`), `src/turns.ts` (`start`, `:283`; `save()`).
- If the raw `state` has a `version` above 3, the tracker logs `turns: stored state version N is newer than this plugin` and makes `save()` a no-op for that run.
- Test in `src/turns.test.ts`: start with `{ version: 4, ... }`, run one save, and confirm that the stored value is unchanged.

### A2. Check A live

- Run `npm test`, then build.
- Reload the plugin in Orca.
- Check that the mtime of `~/Library/Application Support/orca/plugins-data/local.agent-inbox/storage.json` changes, and that the value of `state` is under 200 KB.
- Check that the plugin log shows no new `value exceeds` line for 10 minutes of normal use.

---

## B. One storage key per session

Revised 2026-11-13 against 0.4.3 (`5c1cc33`). It resolves banner items 4–7. Release: 0.5.0.

Orca's limits (`plugin-host-api-storage-schemas.js:14-16` in the app): 256 KiB for each value, 5 MiB in total, 1024 keys. The installed host type has `delete` and `keys` (`.orca/types/orca-services/index.d.ts:93-94`). Live on 2026-11-13: 159,113 bytes in total, 56 sessions, the largest session is 6,501 bytes, and the non-session fields are 9,182 bytes.

### Layout

- `session:<id>`: one `SessionState`.
- `state`: the index, `{ version: 4, terminals, panes, moved, paneLaunches, pendingCodex }`. It has no `sessions` field.
- `state.v3`: the v3 value as it was before the migration, written once.
- The sessions are the `session:*` keys that `keys()` returns. The index does not list them, so no index can point at a key that is missing.

### How items 4–7 are resolved

- **4. Index version and the runtime shape.** Only load and save in `src/turns.ts` read or write version 4. The state in memory stays `CurrentState` with `version: 3` and a full `sessions` map. So `src/socket.ts:130-148` and `src/presses.ts:256` do not change. `newerVersion` (`src/state.ts:189-190`) changes from `> 3` to `> 4`.
- **5. One session's size, and one failed write (revised 2026-11-13 for RB-1).**
  - Bound. `enqueue` (`src/turns.ts:272-285`) stores each queued exchange clipped to the limits that `buildPrompt` already applies (`src/core/model-text.ts:254-256`): `person` 4,000, `activity` 2,500 and `reply` 12,000 characters. The model never reads more than this. Move the three limits to named constants that both use.
  - Known effect: `buildPrompt` numbers code blocks before it clips (`src/core/model-text.ts:256`). A reply clipped through a code fence can number its tail blocks differently. The model reads the same characters.
  - `enqueue` does not add a turn when the queue already holds a turn and the session with the new turn passes `SESSION_MAX`. The turn stays in the transcript. The next `done` or start reads it again from the last queued offset (`readFrom`, `src/turns.ts:145-147`).
  - Nothing else is trimmed. Save never drops open items, findings, closed records or press labels (the hand-off receipts) to fit.
  - Backstop. At save, a session over `SESSION_MAX = 200_000` bytes is not written. The log names it, and the key keeps its last value. The largest live session is 6,501 bytes.
  - Each save writes every changed session key, then the index. A rejected or skipped session write does not stop the other session writes or the index write.
  - A rejected session write clears that session's last-written JSON, so the next save writes it again.
  - Durability. `edit(id)` (`src/turns.ts:445-449`) keeps its contract of today: it rejects when its change is not stored. Stored now means the `session:<id>` key.
    - `save()` keeps a map `landed`: for each session, the promise of the last write that it queued. For a session skipped as oversized, `landed` holds a rejected promise.
    - `edit(id)` returns `landed.get(id)` after its save. A session whose JSON did not change keeps the earlier promise, so an edit never resolves on a write that later fails.
    - `save()` itself still settles with the index write, as it does today with `state`. Every caller other than `edit` keeps this.
  - How each caller learns it. Neither path needs a code change.
    - `handOff()` catches the rejection, restores the label, and returns `{ ok: false }` before `worktree create` (`src/worker.ts:674-685`).
    - Socket `record` and `close` call `deps.edit` through `apply` (`src/socket.ts:109-117`, `:169-178`). The rejection reaches the server's catch, which logs `socket: …` and answers `{ error: 'failed' }` (`src/socket.ts:236-238`). The agent's tool call fails.
- **6. Migration backup and rollback.**
  - The migration first writes `state.v3`, then each `session:<id>`, then the v4 index.
  - Until the index write, `state` is still v3, so a crash reruns the whole migration from the v3 value.
  - 0.4.3 refuses a newer version: `newerVersion` sees 4 (`v0.4.3:src/state.ts:189-190`), `readOnly` is set (`v0.4.3:src/turns.ts:374`), and `save()` writes nothing (`v0.4.3:src/turns.ts:173`). No `sessions` field means it loads no sessions (`v0.4.3:src/state.ts:205`).
  - So 0.4.3 never overwrites stored data: open items and hand-off receipts stay in the `session:*` keys, and 0.5.0 finds them again. 0.4.3 still tracks and hands off in memory, so the supported rollback is to disable the plugin (see Decisions); anything 0.4.3 creates is lost.
- **7. Mixed generations.** Each key holds whole values, and load makes the cross-references consistent:
  - A terminal, pane or `moved` entry that points at a session with no key is dropped, with the filters in `without()` (`src/turns.ts:88-97`).
  - A session whose binding is missing, because the index write failed, rebinds at its next prompt through `adopt` (`src/socket.ts:151-153`, `src/worker.ts:490-500`).
  - A session key that should have been deleted loads again. It is still evictable, so the next budget save drops it again.
  - Commit point (added 2026-11-13 for RB2-3). The index write is the commit point. A save does not write the index while the index points at a session that has no stored key: one whose first write failed or was skipped. The save rejects. A session that has a stored key does not block the index, so RB-1 holds for it.
  - Undo (added 2026-11-13 for RB3-2). When a new session's first write fails, `track` and `rebind` undo their change in memory, so the barrier clears and memory does not run ahead of storage. They use the same conditional undo as `edit(…, { undoOnFail: true })` (`src/turns.ts:449-459`): keep the state from before, and restore it only when the changed parts are still the ones this call made. For `rebind`, those parts are the session, the terminal binding and the `moved` entry. Then they reject.
  - Rebind. Today `bindClaude` makes three saves: `track` (`src/worker.ts:468`), `learn` (`:469`) and `move` (`:470`). A crash between them stores a binding without its alias. Load then drops a `moved` entry whose session has no key (`src/turns.ts:95`), and socket `record` and `close` route through `moved` (`src/socket.ts:138-148`).
  - Fix: a new `tracker.rebind(terminalId, launchSession, sessionId, opts)`. `opts` is the `track` options plus `transcript` and `cwd`. It makes the `track` change, the `learn` change and the `move` change as one change in memory, then one save. That save writes `session:<sessionId>` first and the index last. `bindClaude` calls `rebind` in place of `src/worker.ts:468-470`. `track` and `move` stay for their other callers.
  - Before the index write lands, the stored index still holds the old binding and the old alias. After it lands, it holds the new ones. A new session key written without its index loads as an unbound session, and later saves evict it.
  - `rebind` applies admission (item 8) to a new session. It rejects when the index write does not land; `bindClaude` passes the rejection to the socket, which answers `{ error: 'failed' }` (`src/socket.ts:236-238`). The next `prompt-start` calls `bindClaude` again (`src/socket.ts:138-146`).
- **8. Key count (added 2026-11-13 for RB-3, revised for RB2-1 and RB2-2).** `keys()` has no pagination (`.orca/types/orca-services/index.d.ts:94`). Orca's `storageKeysResult` schema has `.max(PLUGIN_STORAGE_KEY_LIMIT)` (`/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/plugins/workers/plugin-host-api-storage-schemas.js:27-29`), so with more than 1024 keys `keys()` fails validation. It does not truncate. Eviction cannot hold the count down: `evictable()` keeps every session with open rows or a queued turn, and returns nothing when live terminals are unknown (`src/turns.ts:68-85`).
  - `MAX_SESSIONS = 960`. The other keys are `state`, `state.v3` and `snoozes` (`src/worker.ts:83`). The rest is spare.
  - The count is the sessions in memory plus two sets of `session:*` keys that have no session in memory:
    - `unreadable`: keys that load could not read, because `get()` failed or the value is not a session. Load logs each one. Save never deletes or writes them. `track` and `rebind` reject an id in `unreadable`, so a new empty session never overwrites the key. The next start reads it again.
    - `pendingDelete`: keys that a save evicted on purpose. A key stays in the set until its delete lands. Each save tries these deletes again.
  - Readmission (added 2026-11-13 for RB3-1). `track` and `rebind` of an id in `pendingDelete` first try that delete again. If it lands, the id is admitted as a new session. If it fails, they reject with the limit error and write nothing. So a late delete can never erase a session that came back.
  - So every `session:*` key in storage is in the count, and the store never holds more than `MAX_SESSIONS` + 3 keys.
  - Admission is in `track()` (`src/turns.ts:394-421`), the only code that makes a new session. A known session always tracks.
  - When a new session finds the count at `MAX_SESSIONS`, `track` evicts the oldest `evictable()` session, saves, and waits for that key's delete. It admits the new session only after the delete lands. When the delete fails, the key stays in `pendingDelete`, and `track` rejects with the limit error and writes nothing for the new session. When nothing is evictable, `track` logs `turns: session limit 960 reached; not tracking <id>` and rejects with that error. It changes no state and writes nothing.
  - Bytes (added 2026-11-13 for RB3-2). `BUDGET` (1 MiB, see Decisions) is also an admission limit. A new session is admitted only when, after eviction, stored session bytes + `INDEX_MAX` (96 KiB, item 9) is under `BUDGET`. Stored session bytes are the last-written JSON of each session, plus the keys in `pendingDelete`, plus `SESSION_MAX` for each key in `unreadable` (its size is not known). Admission evicts the oldest `evictable()` sessions until both the count and the bytes fit, with the same wait for each delete. When they do not fit, it rejects with the limit error, as for the count.
  - Growth after admission. Admitted sessions keep growing: open rows, queued turns. `BUDGET` does not bound that, because the worst case is 960 × `SESSION_MAX` = 192,000,000 bytes, far over 5 MiB. So save has a second, hard guard: `TOTAL_MAX` = 4 MiB (4,194,304 bytes) for all session keys. Save skips a session write that would take that total past `TOTAL_MAX`, the same way it skips an oversized session (item 5): it logs it, and `edit` on that session rejects. `enqueue` holds a turn that would take the total past `TOTAL_MAX`, as it does for `SESSION_MAX`.
  - Arithmetic. Session keys ≤ 4,194,304. Index ≤ 183,296 (179 KiB, item 9). `state.v3` ≤ 262,144, because Orca refuses a larger value. `snoozes` holds one number per snoozed row and drops expired ones (`src/worker.ts:356`). Sum without `snoozes`: 4,639,744 bytes, which leaves 603,136 bytes (589 KiB) under 5 MiB = 5,242,880.
  - The caller sees it. Each caller already handles a rejecting `track`, because `track` rejects today when its save fails (`src/turns.ts:420`). Launch logs `launch: could not track` (`src/worker.ts:181`). `adopt` (`src/worker.ts:499`) rejects into the socket, which answers `{ error: 'failed' }` (`src/socket.ts:236-238`).
- **9. Index size (added 2026-11-13 for RB3-3).** `paneLaunches` grows in `clearPane` and `markPaneLaunch` (`src/turns.ts:354`, `:360-363`). `pendingCodex` grows in `stageCodex` (`src/turns.ts:473-481`). Neither shrinks on eviction (`src/turns.ts:88-96`).
  - On each save, drop a `paneLaunches` entry when live terminals are known (`deps.live()` is not null), no live terminal in `terminals` has that pane key, and the entry is older than `KEEP_MS` (`src/turns.ts:57`). The age rule keeps a launch whose terminal is not bound yet (`markPaneLaunch` runs before the binding, `src/worker.ts:211`).
  - Caps, applied on each save, oldest first: `paneLaunches` keeps the 100 newest entries by time. `pendingCodex` keeps the 3 newest entries per pane and the 20 most recently changed panes.
  - `markPaneLaunch` and `stageCodex` do not store a pane key, thread id, Codex home or turn id longer than 256 characters. They log it.
  - Worst case of the two capped fields: `paneLaunches` 100 × about 280 bytes = 28,000. `pendingCodex` 20 × (260 + 3 × about 820) = 54,400. Together about 82 KiB.
  - Id length. `track`, `rebind`, `move` and `bind` reject a session id or pane key over 128 characters, and write nothing. Codex home keeps the 256-character limit above. Terminal handles are already at most 133 characters (`src/socket.ts:93`). So one session adds at most about 1,300 bytes to `terminals`, `panes` and `moved`: a terminal entry about 425, a pane entry about 580, a `moved` entry about 262.
  - `INDEX_MAX` = 96 KiB (98,304 bytes) for `terminals`, `panes` and `moved` together. A call that adds to them (`track`, `rebind`, `move`, `bind`) rejects and undoes its change (item 7) when these three fields would pass `INDEX_MAX`. The same constant is the index's share in the admission byte sum (item 8).
  - Worst case of the whole index: 96 KiB + 82 KiB for the capped fields + about 1 KiB for the other fields = about 179 KiB, under 256 KiB. With 128-character ids, `INDEX_MAX` holds about 75 sessions with full bindings. With UUID ids (36 characters), one session adds about 350 bytes, so it holds about 280. Live on 2026-11-13, the non-session fields are 9,182 bytes for 56 sessions (see above).

### B1. Storage type and test fakes

- Files: `src/turns.ts:22-26` (add `delete` and `keys`), `src/test-clock.ts:30` (`rejectingStorage`), and the fakes in `src/turns.test.ts:117`, `src/presses.test.ts:40`, `:564`, `src/socket.test.ts` and `src/worker.test.ts`.
- Each fake is a Map over any key, with `keys()` and `delete()`. `rejectingStorage` gets a hook that makes the Nth write reject (for B3), and a hook that makes every write to one named key reject (for B2).
- Add one fake that enforces Orca's limits: `set` rejects a value over 262,144 bytes, and rejects a new key when 1024 keys exist. `keys()` rejects when more than 1024 keys exist, as Orca's schema does. `delete` and `get` get the same reject hooks as `set`.
- Test: the existing suite passes with no change in behavior.

### B2. Save: changed sessions, then the index

- Files: `src/turns.ts` (`save()` `:172-191`, `enqueue` `:272-285`, `track` `:394-421`, `edit` `:445-449`), `src/state.ts` (`splitState`, `joinState`), `src/core/model-text.ts` (the three clip limits at `:254-256` become named constants).
- Change:
  - Keep the JSON of each session as it was last written, and write a key only when the JSON changed. Skip a session over `SESSION_MAX`, and log it.
  - Then write the index when it changed, unless it points at a session with no stored key (item 7).
  - Then delete the keys of the sessions that this save evicted, and the keys left in `pendingDelete`. Never delete a key in `unreadable`.
  - All of this stays on the one `writes` chain (`src/turns.ts:185`).
  - `save()` writes nothing until `start()` has loaded.
  - Keep `landed`, and make `edit(id)` return `landed.get(id)` (item 5).
  - `enqueue` clips the exchange, and holds a turn that would push a session with a queued turn over `SESSION_MAX` (item 5).
  - `track` and `rebind` apply admission (item 8): the count, `BUDGET`, `INDEX_MAX`, the 128-character id limit, and the `pendingDelete` retry. `move` and `bind` apply `INDEX_MAX` and the id limit (item 9). They undo a failed admission (item 7).
  - Save skips a session write past `TOTAL_MAX`, and applies the index caps (item 9). `markPaneLaunch` and `stageCodex` refuse fields over 256 characters.
  - Add `rebind()`, and call it from `bindClaude` (`src/worker.ts:468-470`) (item 7). Files: also `src/worker.ts`.
- Budget: `evictable` and `without` stay as they are (`src/turns.ts:68-97`). `BUDGET` measures the total of all keys. The key count is held by admission (item 8), not by eviction in save.
- Tests in `src/turns.test.ts`:
  - An `edit` writes one `session:<id>` and no other session.
  - A rejected write to `session:<id>` makes `edit(id)` reject. The index and another session changed in the same save are still written. The next save writes that session again.
  - A session over `SESSION_MAX` (made of open items, so nothing can be trimmed) is not written, `edit` on it rejects, and one log line names it. Its open items stay in memory, and its key keeps its last value.
  - A queued turn with a 1 MB `reply` and a 1 MB `person` is stored clipped to the prompt limits, and the session is written.
  - With one turn queued, a second turn that would pass `SESSION_MAX` is not queued. After the first turn drains, the next `done` queues it.
  - An evicted session's key is deleted after the index write. A failed delete stays in `pendingDelete`, and the next save deletes it.
  - With the capped fake and every delete failing: at the limit, each new `track` evicts a session, its delete fails, and `track` rejects with the limit error. Over 100 tries, the fake never holds more than `MAX_SESSIONS` + 3 keys.
  - A new session whose first write fails: the index is not written, the save rejects, and the next save writes the session, then the index.
  - Admission, with the fake that enforces the 1024-key cap and `live` returning null: track 1,100 new sessions, and give each an open item through `edit`. The first 960 track and persist. Each later `track` rejects with the limit error, logs one line, and adds no key. The fake holds at most 1024 keys. A restart loads all 960 sessions.
  - At the limit with one evictable session, a new `track` evicts it and succeeds.
  - Readmission: evict X, make its delete fail, then `track` X. While the delete keeps failing, `track` rejects and writes nothing. Once the delete lands, `track` X succeeds, X gets an open item, and after the next 3 saves and a restart, X's open item is still stored.
  - Bytes: with sessions of 100 KB of open items each, `track` admits sessions until stored bytes + `INDEX_MAX` would pass 1 MiB, then rejects with the limit error. The fake's total stays under 5 MiB.
  - `TOTAL_MAX`: grow admitted sessions with open items until the total would pass 4 MiB. The write that passes it is skipped, and `edit` on that session rejects.
  - Undo: a new session's first write fails. `track` rejects, the session is not in memory, and the next save writes the index. The same for a `rebind`: the old binding and alias are back in memory.
  - Index caps: call `markPaneLaunch` for 500 panes and `stageCodex` for 100 panes × 10 turns, with 256-character fields. Then `track` sessions with 128-character ids and pane keys until `INDEX_MAX` refuses one, and `track` one id of 129 characters. Each save writes the index, `paneLaunches` holds 100 entries, `pendingCodex` holds 20 panes of 3, the 129-character id and the refused session reject and write nothing, and the index stays under 256 KiB.
- Tests in `src/worker.test.ts`:
  - `handOff` with every write to the session's key rejected: it returns `{ ok: false }`, and `deps.orca` never gets `worktree create`.
  - `handOff` on a session over `SESSION_MAX`: the receipt write is skipped, it returns `{ ok: false }`, and `deps.orca` never gets `worktree create`.
- Tests in `src/socket.test.ts`:
  - `record` with the session's write rejected: the server answers `{ error: 'failed' }`.

### B3. Load and migrate

- Files: `src/turns.ts` (`start` `:369-382`), `src/state.ts` (`upgradeState` `:197`, `newerVersion` `:189-190`).
- Change:
  - Read `state`.
  - If it is v1 to v3, do the migration in item 6. That is 3 + N writes, with no other save in between.
  - If it is v4, read every `session:*` key from `keys()`, send each through `upgradeSession`, and join them with the index. Then drop the references that point at sessions with no key. A `session:*` key whose `get()` fails or that does not read as a session goes into `unreadable` (item 8). When `keys()` rejects, start logs it and stays read-only, as for a newer version, so it never overwrites what it could not list.
  - A version above 4 stays read-only, as today.
- Tests in `src/turns.test.ts`:
  - The live-sized v3 fixture migrates. `state.v3` equals the old value, and no value is over 256 KiB.
  - v4 round-trips through a save and a load, and keeps open items and a hand-off receipt.
  - A failure injected at each write of the migration in turn: a restart reruns it and ends with every session and its receipt.
  - A `get()` that fails once at load for one `session:*` key: no save deletes or writes that key, and the next start loads the session.
  - A failure injected at each write of a `rebind` in turn, for a new session and for a known one. After the restart, the stored state is one of two: the old binding and the old alias, or the new binding, the new alias and the new session key. Never a mix. A `record` and a `close` sent with the launch id reach the session that the alias names.
  - `keys()` that rejects at start: the log says so, and no save writes.
  - The index has no `sessions` field, and its `version` is 4: the two facts that make 0.4.3 read-only.

### B4. Release 0.5.0 and check it live

- Files: `package.json`, `package-lock.json` (two places), `orca-plugin.json`, as in d52241d. `docs/live-check.md`: a new section `## Per-session storage (0.5.0) — <date>`.
- Commits: `Release 0.5.0: one storage key per session`, then `Record the 0.5.0 live check`.
- Live check:
  - Reload. `storage.json` has `state` (version 4), `state.v3` and one `session:<id>` key for each session. No value is over 256 KiB.
  - Every terminal from `orca terminal list --json` with an `agentIdentity` still has its binding. Open rows and hand-off receipts are as before.
  - Rollback: disable the plugin. Confirm that the hash of `storage.json` does not change while the plugin is disabled. Enable it again, and confirm that the open rows are back.
  - Restart Orca once. The open rows survive.

### Decisions (user, 2026-11-13)

- **`BUDGET` = 1 MiB (1,048,576 bytes)** for the total of all keys. Old sessions are evicted only above it.
- (revised 2026-11-13, from the round-3 audit the user chose to fix): BUDGET is also the admission limit for new sessions; TOTAL_MAX 4 MiB is the hard guard.
- **Rollback (revised 2026-11-13): disable the plugin.** This is the supported rollback from 0.5.0. Installing 0.4.3 over 0.5.0 is not supported. Rows and receipts that 0.4.3 creates while rolled back are lost. There is no 0.4.4 build.

---

## Out of scope

- `KEPT_SESSIONS = 40` (`src/core/ledger.ts:8`) is defined but never used. Do not touch it here.
- Any change to `PRUNE_MS` (`src/turns.ts:53`).

<!-- Audit findings are added below by /audit-plan. -->
