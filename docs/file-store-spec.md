# Spec: keep the state in a file

Status: decided 2026-11-19; points 6–7 and the corrupt-file rule revised the same day after the plan audit (`docs/file-store-plan.md`). Not built.

## Problem

The worker keeps its whole state under one Orca storage key, `state` (`src/state.ts:7`). Orca rejects a value over 262144 bytes. On 2026-11-19 the state on the user's machine reached 259,994 bytes and every save failed with `value exceeds 262144 bytes`. New agents were not tracked and no record survived a restart.

Eviction cannot fix this. It never drops a session with an open row (`src/turns.ts:106`). Trimming closed rows was measured on a copy of the real state and freed about 2.5 KB. Plan B in `docs/state-size-plan.md` (one key per session) stopped after four audit rounds.

## Decision

The worker keeps the state in `~/.orca-agent-inbox/state.json`, written with `node:fs`. A file has no size cap.

1. **Only the state moves.** The `snoozes` key stays in Orca storage (`src/worker.ts:385-396`).
2. **The path is fixed:** `~/.orca-agent-inbox/state.json`. The folder is created with mode 0700 and the file with mode 0600, because the state holds transcript text. A dev copy and an installed copy that run at the same time share this file. The owner check (point 4) keeps one writer.
3. **A save writes a temp file in the same folder, then renames it over `state.json`.** This is the pattern of `stableBinPaths` (`src/socket.ts:39-62`). A failed write or rename rejects, as a failed `storage.set` does now, so `edit()`, `record` and `close` still report a failed save (`src/turns.ts` `edit`). The temp file is removed on failure.
4. **Owner check.** At start, each worker writes a new random id to `~/.orca-agent-inbox/owner` (temp file, then rename). Before each save, the worker reads `owner`. When the id is not its own, a newer worker has started: the old worker stops saving (the store keeps its own flag; a save then resolves and writes nothing, as a read-only tracker save does at `src/turns.ts:215`), and logs `turns: another worker owns the state`. A save already past the check can still land; this window is one read and one rename long, and it is accepted.
5. **Migration: copy once, keep the old key as a backup.** At start, when `state.json` does not exist, the worker reads Orca's `state` key and writes it to `state.json`. From then on it never writes the `state` key. A rollback to 0.4.6 loads that frozen key: an older inbox, not an empty one.
6. **Rollback then forward: copy the changed key again.** At migration the worker writes a fingerprint of the copied key (sha256 of its JSON; the key being empty counts) to the sidecar file `state.json.from`. At start, when the `state` key's fingerprint differs from the sidecar, 0.4.6 wrote the key after the migration. The worker copies `state.json` to `state.json.pre-rollback-<time>`, copies the key to `state.json` again, writes the new fingerprint, and logs it. A sidecar, not a field in `state.json`: `upgradeState` builds a new object of known fields only (`src/state.ts:197-215`), so a field would need the store to add it on every save and strip it on every load.
7. **Load guard.** Saves are enabled only after the load of the state succeeds. Any failure in reading, migrating or upgrading the state (for example `upgradeState` throwing on `items: [null]`, `src/state.ts:162`, `src/core/ledger.ts:76`) latches: from then on a save rejects and writes nothing, until a restart. The store runs `upgradeState` on the loaded value as a check, because the tracker's own failure is only logged (`src/worker.ts:376-378`) and leaves the tracker on the empty state.

## Kept as today

- The tracker's `Storage` shape stays `get` and `set` (`src/turns.ts:22-26`). The file store implements it, so the tracker and its test fakes do not change.
- `upgradeState` and the newer-version guard stay (`src/state.ts:189-197`, `src/turns.ts:424-431`): a file whose version is newer than the code makes the worker read-only.
- `BUDGET` and session eviction stay as they are (`src/turns.ts:60-61`). Without the cap they bound growth; they no longer decide whether a save works.
- One whole-state write per save, in order, on the existing `writes` chain (`src/turns.ts:231`).

## Edge cases

- **Corrupt `state.json`** (bad JSON): the worker writes the corrupt bytes it read to a new file `state.json.corrupt-<time>`, logs it, and loads Orca's `state` key as in point 5. It never renames or removes `state.json`: the next owner-checked save replaces it. So a worker that lost ownership cannot move a newer worker's valid file.
- **Leftover temp files** from a crash are left in place; nothing deletes a temp file, because age cannot tell a crash's leftover from a suspended write.
- **Test runs:** `orca plugin test` and `orca plugin check` set `ORCA_PLUGIN_TEST_ROOT` (`src/worker.ts:779-785`). The worker then uses Orca's in-memory storage, as today, and never touches `~/.orca-agent-inbox`.
- **Home folder not writable:** the save rejects and logs, as a failed `storage.set` does today.
- **Parseable but bad state** (valid JSON that makes `upgradeState` throw): the load guard (point 7) latches. The file stays byte-identical.

## Tests

- File store, in a real temp folder: a save then a load gives the same state; a failed rename rejects and leaves the old file; a leftover temp file is left in place and does not affect load or save; a corrupt file is moved aside and the backup key loads; files have modes 0700 and 0600.
- Owner: a second store that takes ownership makes the first stop saving and set its own `readOnly`.
- Migration: with no file, the `state` key is copied once; after that, saves do not write the key.
- Corrupt race: store A reads corrupt bytes and waits; store B takes ownership, quarantines, migrates and saves; A goes on. B's valid `state.json` survives.
- Rollback round trip: migrate; 0.4.6 writes a record, a close and a handoff receipt to the key; restart; all three are present, and `state.json.pre-rollback-*` holds the file from before.
- Load guard: a worker whose file makes `upgradeState` throw leaves the file byte-identical through later tracking and `record` calls.
- Every operation that replaces or moves persisted state has a failure-path test.
- Worker: under `ORCA_PLUGIN_TEST_ROOT` no file is created.
- A state over 262144 bytes saves.

## Live check

After install: `~/.orca-agent-inbox/state.json` exists, its mtime changes on a record, and the `state` value inside Orca's `storage.json` stops changing (snoozes still write that file). Run `orca plugin dev load .` twice in a row: the log shows the old worker's `another worker owns the state`, and the newer worker's saves land.

## Out of scope

- Moving snoozes.
- SQLite. Revisit only if the plugin needs per-session writes or queries.
- Removing the old `state` key from Orca storage.
