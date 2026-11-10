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

### Layout (version 4)

- `state`: everything that is not a session body (`terminals`, `panes`, `moved`, `paneLaunches`, `pendingCodex`), plus `version: 4` and `sessions: string[]`, the list of live session ids.
- `session:<id>`: one `SessionState` for each id.

`src/socket.ts:125-143` reads only `version`, `panes` and `moved`, so `socket.ts` keeps working if those fields stay on `state`.

### Atomicity

Today one write saves a whole commit (`src/state.ts:6`). B gives up that property. The write order limits the damage:

1. Write each changed `session:<id>` key.
2. Write `state` last.
3. Delete the keys of sessions that `prune` removed.

If the process crashes between steps, the saved index is the old one, and every id in it still has a key. An orphan `session:*` key that no index lists gets deleted on the next load.

### B1. Widen the storage type and the test fakes

- Files: `src/turns.ts:22-26` (add `delete` and `keys`, which Orca's `StorageApi` has), plus the fakes in `src/turns.test.ts:59-84`, `src/socket.test.ts:41-52`, `src/presses.test.ts:36-37` and `src/worker.test.ts:49-50`.
- Each fake becomes a Map over any key.
- Test: the existing suite passes with no change in behavior.

### B2. Save: write changed sessions, then the index

- Files: `src/turns.ts` (`save()`), `src/state.ts` (the v4 type, and `splitState` / `joinState`).
- Keep the JSON of each session as it was last written. Write a session key only when that JSON changed. Most saves then write one session plus the index.
- Keep the single `writes` promise chain (`src/turns.ts:120`), so saves stay in order.
- Tests in `src/turns.test.ts`:
  - A save writes only the session that changed, and writes `state` last.
  - A crash after a session write and before the index write restarts into a consistent state.

### B3. Load and migrate

- Files: `src/turns.ts:283`, `src/state.ts` (`upgradeState`).
- Read `state`.
  - If `state` has inline sessions (v1 to v3), upgrade them as today. Then write every `session:<id>` key, and then write the v4 index.
  - If `state` is v4, read each listed `session:<id>` and send it through `upgradeSession`.
  - If a listed key is missing, drop that id.
- Delete every `session:*` key that `keys()` returns and the index does not list.
- Tests in `src/turns.test.ts`:
  - A 277 KB v3 fixture loads, and every value it writes is under 256 KiB.
  - A v4 state round-trips through a save and a load.
  - An orphan key gets deleted.

### B4. Check B live

- Do the same checks as A2, plus: run `keys()` once through the worker log and confirm one `session:*` key for each listed id.
- Restart Orca once and confirm that open inbox rows survive.

---

## Out of scope

- `KEPT_SESSIONS = 40` (`src/core/ledger.ts:8`) is defined but never used. Do not touch it here.
- Any change to `PRUNE_MS` (`src/turns.ts:53`).

<!-- Audit findings are added below by /audit-plan. -->
