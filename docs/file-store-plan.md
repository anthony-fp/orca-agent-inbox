# Plan: keep the state in a file (0.4.7)

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-19) — HIGH. Do not build unchanged: the load guard misses schema-upgrade failures, corrupt-file recovery can move another worker's valid state, and rollback recovery is undefined.**
>
> The guard only latches rejected `get` calls. Valid JSON can fail inside `upgradeState` (a ledger with `items: [null]` passes `src/state.ts:162`, then `upgradeItem` dereferences null); `tracker.start` fails before it assigns the state, `src/worker.ts:376-378` logs and goes on, and later saves can overwrite the inbox with the empty state. Corrupt recovery renames `state.json` without the owner check: worker A reads corrupt bytes and pauses, worker B quarantines, migrates and saves valid state, then A renames B's valid file to its corrupt name, and A's migration skips the write because it lost ownership — no `state.json` is left. After 0.4.7 → 0.4.6 → 0.4.7, 0.4.6's records, closes and handoff receipts live only in the Orca key, and 0.4.7 silently loads the stale file; both use schema version 3, so `newerVersion` cannot see it.
>
> **Redesign required before build:**
> 1. **[high] Latch failures across reading AND upgrading the state before saves are enabled.** Worker regression: parseable JSON that makes `upgradeState` throw; later tracking and `record` calls leave the file unchanged.
> 2. **[high] Make quarantine unable to move a replacement file.** Proposed: copy the corrupt bytes to `state.json.corrupt-<time>` instead of renaming, and let the owner-checked save replace `state.json`. Barrier-controlled two-store test of the interleaving above.
> 3. **[medium] Define rollback-then-forward recovery.** Decision pending with the user. Add a round-trip test with a record, a close and a handoff receipt.
>
> **Status:** Resolved — see below.
>
> **Resolved 2026-11-19:**
> 1. Load guard, widened (user decision). Saves are enabled only after `get(STATE_KEY)` resolves. Every failure inside it latches: the read, the corrupt copy, the backup read, an `upgradeState` check the store runs on the value, and the migration or recopy write. While latched, a save rejects and writes nothing. F1 has the store tests; F4 adds the worker regression: a file with `items: [null]` stays byte-identical through tracking and `record` calls.
> 2. Quarantine copies, never moves (user decision). The store writes the corrupt bytes it read to a new `state.json.corrupt-<time>` (flag `wx`) and leaves `state.json` in place; the next owner-checked write replaces it. F2 adds the barrier-controlled two-store test of the audit's interleaving: B's valid `state.json` survives.
> 3. Rollback then forward: copy the changed key again (user decision). A new task, F3: a sidecar `state.json.from` holds the sha256 of the copied key's JSON. When the key's fingerprint differs at start, the store copies `state.json` to `state.json.pre-rollback-<time>`, copies the key again, writes the new fingerprint and logs it. Sidecar, because `upgradeState` keeps known fields only (`src/state.ts:197-215`). Round-trip test with a record, a close and a handoff receipt.
>
> Workflow note applied: every operation that replaces or moves persisted state has a failure-path test (table in "Failure paths").

Branch: `anthony-fp/review-orca-plugin-improvements`. Source: `docs/file-store-spec.md` (decided 2026-11-19). This plan does not re-decide the spec. Line numbers are from 49e97eb (0.4.6).

Gate after every task: `npm test`, `npm run typecheck`, `npm run typecheck:worker` and `orca plugin validate .` pass. A failing gate blocks the next task. Each task is one commit. Write each task's tests first, and see each new-behaviour test fail before the change.

The tracker does not change. The file store implements `Storage` (`src/turns.ts:23-26`), and the worker hands it to `createTracker` in place of `orca.storage` (`src/worker.ts:350-351`).

---

## F0. Baseline

- Run `npm test`. It reports 421 passing tests in 15 files (checked 2026-11-19 on 49e97eb). Stop and report if the count differs. F0 has no commit; note the count in F1's message.

## F1. A file store with migration

- Files: new `src/file-store.ts`, new `src/file-store.test.ts`, `src/turns.ts` (comment at `:60` only).
- Change: `fileStore({ dir, backup, log, fs? }): Storage`. `backup` is Orca storage. `fs` overrides `readFile`, `writeFile` and `rename` from `node:fs/promises`; it exists only so tests can fail or pause one call.
  - Start (once, lazily, before the first `get` or `set` runs): `mkdir(dir, { recursive: true, mode: 0o700 })`, then `chmod(dir, 0o700)` for a folder that already exists, as `stableBinPaths` does (`src/socket.ts:43-46`). No temp file is deleted at start (review round 2: age cannot tell a crash's leftover from a suspended write).
  - One write helper for every file the store replaces: write to `<name>.tmp-<6 random bytes hex>` with mode 0600, then rename over `<name>`. On a failure, unlink the temp file and reject with the first error.
  - `get(STATE_KEY)`: read `state.json` and `JSON.parse` it.
    - ENOENT: read `backup.get(STATE_KEY)`. When that is not null, write it to `state.json` with the helper (migration). Return it.
    - Bad JSON: write the bytes it read to a new file `state.json.corrupt-<Date.now()>` (mode 0600, flag `wx`), log `turns: state.json is corrupt, copied to <name>`, then do as for ENOENT. `state.json` is never renamed or removed; the migration write replaces it.
    - Run `upgradeState(value)` on the value it will return, as a check only; the tracker upgrades it again (`src/turns.ts:431`).
  - Load guard (spec point 7): saves are enabled only after `get(STATE_KEY)` resolves. Any rejection or throw inside it latches: from then on `set(STATE_KEY)` rejects with that error and writes nothing. A `set` before the first `get` rejects too; the worker saves only after `ready` (`src/worker.ts:188`, `:230`). Reason: a failed `tracker.start` leaves the tracker on the empty state (`src/turns.ts:197`, `:425-431`) and the worker only logs it (`src/worker.ts:376-378`).
  - `set(STATE_KEY, value)`: write `JSON.stringify(value)` to `state.json` with the helper. `backup.set` is never called for `STATE_KEY`.
  - Any other key goes to `backup` unchanged.
  - `src/turns.ts:60`: the `BUDGET` comment says the limit is Orca's. Change the comment only: the budget bounds growth. No code in `src/turns.ts` changes.
- Tests in `src/file-store.test.ts`, in a real temp folder made with `mkdtempSync(join(tmpdir(), 'oai-'))` and removed in `after`, as in `src/socket.test.ts:345-356`:
  - `a saved state loads back the same in a new store`.
  - `a state over 262144 bytes saves and loads`.
  - `a failed rename rejects, removes its temp file and leaves the old state.json`: `rename` rejects on the second save.
  - `a folder that is not writable makes the save reject`: `chmod(dir, 0o500)` after start. Skip when `process.getuid?.() === 0`.
  - `a leftover state.json.tmp-* file is left in place and does not affect load or save`.
  - `a corrupt state.json is copied aside and the backup state key loads`: one `state.json.corrupt-*` file holds the corrupt bytes, the log has the line, and `state.json` now holds the backup value.
  - `the folder has mode 0700 and state.json 0600, also when the folder existed as 0755`.
  - `with no state.json the backup state key is copied once, and saves never write it`: a fake `backup` counts calls. After `get`, `state.json` equals the backup value. After `set`, `backup.set` has no call. A second store on the same folder, whose backup holds a different value, loads the file.
  - `with no state.json and no backup key, get gives null and writes no file`.
  - Load guard, each ending with a `set` that rejects and a `state.json` that is byte-identical (or still absent):
    - `a read error latches`: `state.json` is a folder (EISDIR).
    - `parseable state that upgradeState rejects latches`: `state.json` holds a session whose `ledger.items` is `[null]` (`src/state.ts:162`, `src/core/ledger.ts:76`).
    - `a backup read that rejects latches`.
    - `a set before the first get rejects`.
  - Failure paths:
    - `a failed migration write rejects get, latches, and leaves no state.json and no temp file`: `fs.rename` rejects.
    - `a failed corrupt copy rejects get, latches, and leaves the corrupt state.json as it was`: `fs.writeFile` rejects for the `corrupt-` name.
  - `another key reads and writes the backup`.

## F2. Owner check

- Files: `src/file-store.ts`, `src/file-store.test.ts`.
- Change:
  - At start, before the temp-file cleanup, the store writes `randomBytes(16).toString('hex')` to `owner` with the F1 write helper, and keeps the id.
  - Inside the write helper, for `state.json` and (from F3) `state.json.from`, the store reads `owner` before the rename. When the text is not its id, or the read fails, the store sets its own `readOnly`, logs `turns: another worker owns the state` once, unlinks its temp file and resolves without the rename. Later writes resolve at once. This is the same answer as the tracker's read-only save (`src/turns.ts:215`). So the migration write and every save go through the check; the corrupt copy does not need it, since it makes a new file and touches no other.
  - A store that lost ownership in `get` still returns the value it loaded; it is not latched, and its saves write nothing.
- Tests:
  - `a second store that takes ownership makes the first stop saving`: store A loads, store B loads, A saves. `state.json` holds what B saved (or B's migration), the log has the line once after two A saves, and a third A save writes nothing.
  - `the owner file has mode 0600`.
  - `a store whose owner file is removed stops saving`.
  - `a corrupt-file race leaves the newer worker's valid state.json` (audit item 2). A `fs.readFile` override holds store A after it reads the corrupt bytes, on a barrier. Store B starts (takes ownership), copies the corrupt bytes aside, migrates the backup and saves a valid state S. Release A. A writes its own `corrupt-` copy, and its migration write finds another owner and does not rename. `state.json` equals S, and a new store loads S.
  - Failure path: `a failed owner write rejects get and latches`: `fs.rename` rejects for `owner`.
- Note: the store's `readOnly` is its own flag. The spec's "sets `readOnly`" cannot mean the tracker's flag: see Spec conflicts.

## F3. Rollback then forward copies the changed key again

> **Audit round 2 (Codex, 2026-11-19), build these into F3:**
> 1. **Check `newerVersion` on the parsed file before the fingerprint check.** A newer-schema `state.json` is returned as-is; the store never replaces it or its sidecar. Test: a store-backed tracker with a version-4 file and a changed fingerprint; both files stay unchanged through later saves.
> 2. **Write the first fingerprint before the first `state.json`.** A crash between the two writes must not hide later 0.4.6 changes. Test: interrupt the first migration between the writes, change the key through 0.4.6, restart; the changes are present.

- Files: `src/file-store.ts`, `src/file-store.test.ts`. Spec point 6.
- Why a sidecar: `upgradeState` builds a new object of known fields only (`src/state.ts:197-215`), so a `migratedFrom` field in `state.json` would need the store to add it on every save and strip it on every load. A sidecar is written only at migration and at a recopy, and `state.json` stays exactly the tracker's value.
- Change:
  - `fingerprint(value) = sha256(JSON.stringify(value ?? null))` in hex.
  - Migration (F1) writes `state.json`, then the key's fingerprint to `state.json.from`, both with the owner-checked helper. A key that is null also gets its fingerprint, so a later 0.4.6 write to it is seen.
  - At each start where `state.json` loads, `get` reads `backup.get(STATE_KEY)` and `state.json.from`:
    - Same fingerprint: load `state.json`.
    - Different: write the bytes of `state.json` to a new `state.json.pre-rollback-<Date.now()>` (mode 0600, flag `wx`), write the key to `state.json`, then its fingerprint to `state.json.from`. Log `turns: the state key changed after migration, copied it again; the old file is <name>`. Return the key.
    - No sidecar: write the key's fingerprint and load `state.json`, as today. Log it.
  - Each step is inside `get`, so a failure latches (F1).
- Tests in `src/file-store.test.ts`:
  - `a rollback to 0.4.6 and forward again keeps 0.4.6's record, close and handoff receipt`. 0.4.6 is a `createTracker` over the `backup` fake, as 0.4.6 runs (`src/turns.ts:23-26`), with `fakeClock` from `src/test-clock.ts`. Seed the key with a session S. Run 0.4.7 (a tracker over a store): migrate and save one edit. Run 0.4.6 on the key: `edit(S, …)` adds an item (a record), moves an item to `ledger.closed` (a close, `src/core/types.ts:79-82`), and sets `presses[id].handoff` (a receipt, `src/state.ts:84`, `:88`). Restart 0.4.7: its `tracker.state()` has all three, one `state.json.pre-rollback-*` file equals the earlier `state.json`, and the log has the line.
  - `a second start after the recopy copies nothing`: no new `pre-rollback-` file.
  - `a key that was empty at migration and is written by 0.4.6 is copied`.
  - Failure paths, each with a latched store:
    - `a failed pre-rollback copy leaves state.json and the sidecar as they were`.
    - `a failed recopy write leaves state.json as it was and keeps the pre-rollback copy`.
    - `a failed sidecar write after the recopy leaves the key's state in state.json, and the next start copies the key again`: the next store loads all three rows.

## F4. The worker keeps the state in the file

- Files: `src/worker.ts` (`WorkerDeps` `:28-46`, `createTracker` `:350-351`, `liveTools` `:778-785`, `activate` `:787-799`), `src/worker.test.ts` (`setup` `:42-113`, the `liveTools` test `:1233-1236`).
- Change:
  - `WorkerDeps`: add `store?(backup: OrcaWorkerApi['storage'], log: (m: string) => void): Storage`.
  - `createTracker`: `storage: deps.store?.(orca.storage, log) ?? orca.storage`. `snoozes` keeps `orca.storage` (`src/worker.ts:385-397`).
  - Export `liveStore(env, home = homedir()): WorkerDeps['store']`, next to `liveTools`. It gives undefined when `env.ORCA_PLUGIN_TEST_ROOT` is set, else `(backup, log) => fileStore({ dir: join(home, '.orca-agent-inbox'), backup, log })`.
  - `activate`: `store: liveStore(process.env)`.
- Tests in `src/worker.test.ts`:
  - `setup` takes an optional `store` and passes it in `deps`. No other existing test changes.
  - `the tracker saves through the injected store, and snoozes stay in Orca storage`: a fake in-memory store. After a record, the fake holds `state` and the host storage has no `state` write. After a snooze, the host storage holds `snoozes`.
  - `a worker that orca plugin check or test starts gets no file store and creates no file`: `liveStore({ ORCA_PLUGIN_TEST_ROOT: '/x' }, home)` is undefined, and the temp `home` stays empty. `liveStore({}, home)` gives a function.
  - `a state file that upgradeState rejects stays byte-identical through tracking and record calls` (audit item 1). `store` is a real `fileStore` in a temp folder whose `state.json` holds a session with `ledger.items: [null]`. Start the worker with a socket (`setup`'s `socket` option, as at `src/worker.test.ts:433`). The log has `start:` (`src/worker.ts:376-378`). A launch, a status change and a `record` over the socket follow; the test does not assert the answer text. `state.json` is byte-identical to the seed, and no `state.json.tmp-*` file is left.

## F5. Release 0.4.7

- Files: `package.json`, `package-lock.json` (two places), `orca-plugin.json`, as in 49e97eb. `docs/live-check.md`: a new section `## File store (0.4.7) — pending` at the end, in the 0.4.6 form (`docs/live-check.md:207-215`). The working tree already has a change to `docs/live-check.md`; keep it.
- `engines.orca` stays `>=1.4.248`: no task uses a new host method.
- Commit: `Release 0.4.7: keep the state in a file`, with a short body as in 49e97eb: the state moves to `~/.orca-agent-inbox/state.json`, so a save no longer fails at Orca's 262144-byte cap; the old `state` key stays as a frozen backup.
- Live check rows (spec `docs/file-store-spec.md:52`):
  - After install, `~/.orca-agent-inbox/state.json` exists with mode 0600 and the folder 0700, and its mtime changes on a `record`.
  - The `state` value in Orca's `storage.json` stops changing. Compare the key, not the file size: snoozes still write that file.
  - `orca plugin dev load .` twice in a row: the log shows `turns: another worker owns the state` from the old worker, and the newer worker's saves land.
  - The 2026-11-19 failure is gone: a `record` with the state over 262144 bytes says "Recorded."
  - `~/.orca-agent-inbox/state.json.from` exists after the first start.

---

## Spec conflicts

- None open. The two conflicts the first draft found are now fixed in the spec: the owner check keeps the store's own flag (`docs/file-store-spec.md:18`, `:41`), since the tracker's `readOnly` is a local `let` in `createTracker` (`src/turns.ts:201`) set only in `start` (`src/turns.ts:428`); and the live check compares the `state` value, not the size of `storage.json` (`docs/file-store-spec.md:52`), since snoozes still write that file (`src/worker.ts:392`).
- The audit decisions changed the spec: points 6 and 7 (rollback recopy, load guard), the corrupt-file rule, a new edge case and new tests (`docs/file-store-spec.md:20-21`, `:32`, `:36`, `:43-46`).
- Lines that moved, corrected in this plan: `liveTools` is at `src/worker.ts:778-785`; `snoozes` ends at `src/worker.ts:397`; `BUDGET` is at `src/turns.ts:61` with its comment at `:60`; `edit` is at `src/turns.ts:507-522`.

## Failure paths

Every operation that replaces or moves persisted state has a failure-path test (audit workflow note).

| Operation | Task | Failure-path test |
|---|---|---|
| Save: temp write, then rename over `state.json` | F1 | `a failed rename rejects, removes its temp file and leaves the old state.json`; `a folder that is not writable makes the save reject` |
| Migration write of the key to `state.json` | F1 | `a failed migration write rejects get, latches, and leaves no state.json and no temp file` |
| Corrupt copy to `state.json.corrupt-*` | F1 | `a failed corrupt copy rejects get, latches, and leaves the corrupt state.json as it was` |
| Owner write | F2 | `a failed owner write rejects get and latches` |
| Write after lost ownership | F2 | `a corrupt-file race leaves the newer worker's valid state.json` |
| Pre-rollback copy | F3 | `a failed pre-rollback copy leaves state.json and the sidecar as they were` |
| Recopy of the key to `state.json` | F3 | `a failed recopy write leaves state.json as it was and keeps the pre-rollback copy` |
| Sidecar write | F3 | `a failed sidecar write after the recopy leaves the key's state in state.json, and the next start copies the key again` |
| Any save after a failed load | F1, F4 | the four load-guard tests; `a state file that upgradeState rejects stays byte-identical through tracking and record calls` |

## Dropped

- **A public `readOnly` on the store.** No production code reads it; F2's tests check the file and the log.
- **A clock dependency for the corrupt-file name.** `Date.now()` is enough; the test matches `state.json.corrupt-\d+`.
- **A folder-owner check** like `stableBinPaths` (`src/socket.ts:45`). The spec does not ask for it, and the folder is under the user's home.

## Risks

- The owner window. A save already past the owner read can land after a newer worker's save (spec point 4, accepted). The newer worker's state is not touched.
- The load guard turns a failed load into failed saves until a restart. Every `record` then says "may have been saved" (its undo save also rejects, `src/turns.ts:518-519`) and nothing is written, which is visible; the alternative is a silent empty inbox. The guard runs `upgradeState` twice at start (store and tracker); the second run cannot throw where the first passed, since the input and code are the same.
- The rollback recopy replaces the 0.4.7 state with the key. 0.4.6 loads the frozen key and rewrites it on its first save: a turn, a record, or a start-up prune that drops a session (`src/turns.ts:386-392`, `:433`). So almost any rollback changes the fingerprint, even one that adds no row. Everything 0.4.7 saved before the rollback then lives only in `state.json.pre-rollback-*`, and the inbox shows the key's older rows. This is the user's decision; recovery is a manual copy of that file.
- Each start now reads the Orca `state` key once for the fingerprint. The key stays near 260 KB on the user's machine (`docs/file-store-spec.md:7`).
- `pre-rollback-` and `corrupt-` files are never removed. Each holds a full state; they grow only on a rollback or a corrupt file.
- `fileStore` does real file work in the worker. A slow disk delays `writes` (`src/turns.ts:231`) as a slow `storage.set` does today; no new timeout is added.
- The test for a folder that is not writable depends on file modes. It skips as root; a CI runner as root would not exercise it.
- `deps.store` takes `orca.storage`, whose host type uses `JsonValue`. `npm run typecheck:worker` must pass without a cast; if it does not, type `backup` as the tracker's `Storage`.

## Out of scope

- Moving snoozes, SQLite, and removing the old `state` key (`docs/file-store-spec.md:47-51`).
- A size cap or a new `BUDGET`. Eviction stays as it is (`src/turns.ts:61`, `:221-228`).

<!-- Audit findings are added below by /audit-plan. -->
