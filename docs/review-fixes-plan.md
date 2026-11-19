# Plan: 0.4.6 review fixes

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-19) — HIGH. Do not implement unchanged: R1 can resurrect failed edits in storage, R8 can skip turns, and R9 risks cancelling launches and deleting drafts.**
>
> Save A snapshots the edited session; save B snapshots that same edit before A rejects. The R1 counter restores A in memory, but B's copy still holds A's row (`src/turns.ts:204-217,481-490`); if B succeeds, restart resurrects a row whose tool call reported failure. R8 reuses a cached turn when the file size matches, but `poll` advances `readFrom(s)` after `enqueue` without file growth (`src/turns.ts:177-178,313-315,343`), so later turns already in the rollout stay unread. R9 can delete a launch generation while its launch is still pending (`src/worker.ts:135-178`), and prunes panel drafts by view membership although snoozed rows and rows missing from `agents.list` leave the view without being deleted (`src/panel.tsx:83-99`, `src/worker.ts:530-591`). R6 still calls `rolloutTurns` on serialized prefix rows, which `JSON.parse`s them again (`src/core/codex-transcript.ts:390-395,485`), so the work stays quadratic. R2 still says "not saved" after a disconnect that follows the send (`src/socket.ts:236-241`).
>
> **Redesign required before build:**
> 1. **[high] R1: define durable rollback for queued snapshots.** Persist the restored session after every snapshot taken before the failure. Test: A rejects, B succeeds, restart, retry.
> 2. **[high] R8: key the turn cache by the requested offset,** or cache parsed rows and pick each turn on its own. Test: several completed turns in an unchanged rollout.
> 3. **[high] R9: protect terminals with in-flight launch work from pruning until that work settles.** Test: a launch paused before tracking, then a newer list that omits its terminal. Keep generation cleanup out until this invariant is tested.
> 4. **[medium] R9: keep nonempty drafts across view absence.** Use real deletion signals or bounded retention. Test: snooze, then restore; section disappears, then returns.
> 5. **[medium] R6: make prefix processing consume parsed rows** and precompute the earlier prompt counts once. Add a parse-count assertion for a multi-turn rollout.
> 6. **[medium] R2: tell a connect failure before send apart from a disconnect or bad reply after send.** Report "may have been saved" for the second. Test: worker persists, then closes without a reply.
> 7. **Coupling with [sending-hotfix-plan](sending-hotfix-plan.md) and [confirm-race-plan](confirm-race-plan.md).** Codex found no blocker in R7's reversal of `sending-hotfix-plan.md:39,49`. Add each regression test before its optimization, not only unchanged-output tests.
>
> **Status:** Resolved — see below. Dropped findings: Codex found no blocker. It could not check the host-API claims because `.orca/types` is absent.
>
> **Resolved 2026-11-19:**
> 1. R1: after the undo in memory, `edit` calls `save()` again. Writes run in order (`src/turns.ts:217`), so this write lands after every snapshot taken before the failure, B's included. New test: A rejects, B succeeds, restart, retry.
> 2. R8: the size-keyed cache is cut. R8 keeps only "one read per tick" for Codex: `poll` passes its bytes to `codexTurn`. New test: three completed turns in an unchanged rollout are all queued.
> 3. R9: launch-map, generation, status and pane pruning are cut. R9 keeps only `plans`, which drops sessions no longer in the state.
> 4. R9: panel pruning is cut, drafts included. No panel map is pruned.
> 5. R6 is cut. R8 removes the second read on the hot path; the whole-file parse per tick stays as in 0.4.5.
> 6. R2: `ask()` gives null only when the request was never written. A timeout, a close with no reply, a socket error or a bad reply after the write give `MAYBE_SAVED`. New test: the worker reads the request, then closes with no reply.
> 7. Gate: in R5, R7 and R8, the regression tests come first and pass on the old code before the change.

Branch: `anthony-fp/review-orca-plugin-improvements`. Source: the review of 0.4.5 (763e076).

Gate after every task: `npm test`, `npm run typecheck` and `orca plugin validate .` pass. From R4 on, `npm run typecheck:worker` passes too. A failing gate blocks the next task. Each task is one commit. In R5, R7 and R8, write the regression tests first, and see them pass on the old code before you change it.

Bugs come first (R1–R3). R4 brings `src/worker.ts` under the type checker before R5–R10 change it.

---

## R0. Baseline

- `node_modules` is missing. Run `npm ci`.
- Run `npm test` and `npm run typecheck`. Both pass; `npm test` reports 395 passing tests. Write the count in the R0 commit message, or stop and report if it differs. R0 has no commit when nothing changed; note the count in R1's message.

## R1. A failed `undoOnFail` save undoes its row when another session saves

- Files: `src/turns.ts` (`update` `:226-228`, `track` `:443-450`, `edit` `:481-491`).
- Fault: `edit` keeps `mine = state.sessions[sessionId]` (`:486`) and undoes only while `state.sessions[sessionId] === mine` (`:489`). Every `save()` maps each session through `pruned()` (`:206`), and `pruned()` always returns a new object (`:170-173`). So any save of any session between the write and its rejection makes the check false, and the row the agent was told "failed" stays in memory.
- Change: add `const edits = new Map<string, number>()` in `createTracker`. `update()` and the session write in `track()` add 1 to the session's count. `save()` does not. `edit` reads the count after its own `update`, and undoes when the count is the same at rejection. The undo itself goes through `update()`.
- Durable rollback: a save of another session between the write and its rejection holds A's row in its snapshot (`src/turns.ts:204-217`). If that write succeeds, storage keeps a row the agent was told "failed". So after the undo, `edit` calls `save()` again and logs a rejection of that save. Writes run in the order they were made (`src/turns.ts:217`), so this write lands after every snapshot taken before the failure. `edit` still rejects with the first error.
- Left open: when the undo save itself fails, storage keeps the row until the next save that succeeds. A retry then gets "Already open." (`src/core/tools.ts:129`), so no row is made twice.
- Tests in `src/turns.test.ts`:
  - `an undoOnFail edit is undone when another session saves before its write rejects`: hold the first `set`, edit session A with `undoOnFail`, edit session B, then reject both writes. A has no new row.
  - `a failed undoOnFail edit stays out of storage after a later save succeeds`: the first `set` rejects and every later one succeeds. Edit A with `undoOnFail`, edit B, release. The stored state has no A row. A new tracker on the same storage (restart) has no A row, and a repeat of A's record gives "Recorded." with one row.
  - The existing test `when a second undoOnFail edit comes before the first write rejects, memory keeps the second edit` (`:819`) still passes.

## R2. A tool call that times out does not say "not saved"

- Files: `bin/ask.mjs` (`:6`, `:23`), `bin/mcp-server.mjs` (`:20`, `:51-54`), `src/socket.test.ts` (`:534-545`).
- Fault: `ask()` gives up after `TIMEOUT_MS` (`bin/ask.mjs:6,23`) and the MCP server then answers "The inbox is not available, so this was not saved." (`bin/mcp-server.mjs:20,52-54`). The worker still runs the request after the client closes (`src/worker.ts:518-519`, `src/socket.ts:168-177`), so the row can be saved.
- A request id is not needed: a repeat call does not save twice. A repeat question or task gets "Already open." (`src/core/tools.ts:129`, `src/core/ledger.ts:836`), a repeat finding gets "Already recorded." (`src/core/tools.ts:168`), and a repeat close gets "Already closed" (`src/core/tools.ts:214`).
- Change:
  - `bin/ask.mjs`: export `MAYBE_SAVED = { maybeSaved: true }`. Set `written = true` in the `connect` handler after `conn.write` (`:30`). Before the write, an error or a close gives null, as today: the worker never saw the request. After the write, the timer (`:23`), a socket error (`:41`), a close with no reply (`:42`) and a reply that does not parse (`:37-38`) give `MAYBE_SAVED`. `prompt-hook.mjs` and `codex-notify.mjs` read only `.text` and `.error`, so they need no change (`bin/prompt-hook.mjs:55-59`, `bin/codex-notify.mjs:77`).
  - `bin/mcp-server.mjs`: on `MAYBE_SAVED`, answer `isError: true` with `The inbox did not answer, so this may have been saved. Call again to check: a repeat is not saved twice.` A worker `{ error }` reply keeps "not saved": `record` and `close` undo their change before the worker replies `failed` (`src/socket.ts:172-176`, `:236-241`, R1).
- Tests in `src/socket.test.ts`:
  - Change `a worker that never answers gives "not available" after the timeout` (`:534`) to `a worker that never answers says the call may have been saved`. It asserts the new text.
  - `a worker that reads the request and closes with no reply says the call may have been saved`. Give the test's `fakeSocket` a mode that ends the connection after it reads the line.
  - `a missing socket or an error answer gives "not available" at once` (`:547`) stays as it is.

## R3. A stale panel load does not overwrite a newer one

- Files: `src/panel.tsx` (`load` `:96-103`).
- Fault: `load()` writes whatever reply comes last. A slow `inbox.view` that started first can land after a newer one and show old rows.
- Change: a module counter `loads`. Each `load()` takes `const n = ++loads`, and writes `loaded` (ready or error) only when `n === loads`.
- Test in `src/panel.test.tsx`: `a slow view reply that lands after a newer one is dropped`. A `mockHost` `inbox.view` handler returns two deferred replies. Resolve the second (new rows), then the first (old rows). The panel shows the new rows.

## R4. Type-check the worker

- Files: new `tsconfig.worker.json`, `package.json` (`scripts`), `.github/workflows/validate.yml` (`:52-56`), `src/worker.ts` (`:356`).
- Today `tsconfig.node.json` leaves out `src/worker.ts`, `src/protocol.ts` and `src/panel-views.ts` (`tsconfig.node.json:12`), because the worker imports `orca/worker` (`src/worker.ts:9`) and those types come from `.orca/types`, which Git ignores (`.gitignore:2`).
- `orca plugin types .` writes `.orca/types`. Checked 2026-11-19 on a copy with Orca 1.4.261: a config that extends `./.orca/types/tsconfig.json`, adds `node_modules/@types` to `typeRoots`, `node` to `types`, `lib: ["ES2023"]` and `skipLibCheck`, and includes `src/worker.ts`, `src/protocol.ts` and `src/panel-views.ts`, gives one error: `src/worker.ts:356`, storage's `JsonValue` record is not `Snoozes`. `src/worker.test.ts` adds 38 errors; it stays out.
- Change:
  - Add `tsconfig.worker.json` as above, and the script `"typecheck:worker": "tsc --noEmit -p tsconfig.worker.json"`.
  - Fix `:356` with a number filter on the stored value, not a cast.
  - CI: find how the Orca checkout makes the typings. The header of each generated file names `pnpm generate:plugin-author-typings` (`.orca/types/orca-host/index.d.ts:2`). Add a step after "Install Orca validator" that writes them to `plugin/.orca/types`, then run `npm run typecheck:worker`. If the checkout at `ORCA_REF` (`validate.yml:14`) cannot write them, bump `ORCA_REF` to the commit of an Orca that can, and say so in the commit.
- No runtime shape checks for host replies (`src/worker.ts:334,530,614`): the typed `orca.host.call` covers them, and the host is trusted.
- Test: `npm run typecheck:worker` passes locally after `orca plugin types .`, and the CI run on the branch shows the new step green.

## R5. Each save serializes once; the panel reload waits 250 ms

- Files: `src/turns.ts` (`save` `:204-224`), `src/worker.ts` (`changed` `:327`).
- Fault: each save runs `JSON.stringify` on the whole state twice (`byteSize` at `:208`, the copy at `:215`), plus once per dropped session (`:213`). Each write posts `inbox.changed` at once (`:219-222` → `src/worker.ts:327`), and each post makes the panel call `inbox.view`, which calls `agents.list` (`src/worker.ts:530`). A drain saves after each turn (`src/turns.ts:265,283,291`).
- Change:
  - `save()`: `let json = JSON.stringify(state)`; the size is `Buffer.byteLength(json)`. Only when sessions are dropped, `json = JSON.stringify(state)` again. The copy is `JSON.parse(json)`.
  - Worker: `changed: reloadSoon` (`reloadSoon` `:192-199`).
- Tests:
  - `src/worker.test.ts`: `three saves in one tick post inbox.changed once, 250 ms later`. Pattern: `:532-547`.
  - Worker tests that assert a post right after a save (`:806`, `:863`, `:878`) advance the clock by `RELOAD_MS` first.
  - The existing over-budget save tests in `src/turns.test.ts` pass unchanged.

## R6. Cut

Cut after the 2026-11-19 audit (item 5). A one-parse fix also needs the prefix prompt count to use parsed rows (`src/core/codex-transcript.ts:390-395`, `:485`), which is more change to copied code than it earns. The repeated parse runs at a Codex bind (`src/worker.ts:411`) and in `confirm()` for Codex (`src/presses.ts:305`), not on each poll tick.

## R7. `confirm()` reads only new bytes, slows after 10 minutes, and stops when its terminal is gone

- Files: `src/presses.ts` (`PressDeps` `:67-76`, `confirm` `:296-322`, constants `:18-23`), `src/worker.ts` (`read` `:251-261`, `listTerminals` `:303-312`, `createPresses` `:329-340`).
- Fault: `confirm()` reads the whole transcript every second (`:299`, `:320`) until a match, `done` + 10 s, or 24 h (`WATCH_MS`, `:23`). A terminal that closes before `done` keeps the loop at 1 s for 24 h.
- Change:
  - Add `readTail(sessionId, from): Promise<Buffer | null>` to `PressDeps`. The worker reads a Claude transcript from byte `from` to its end with one file handle. It returns null for Codex, and `confirm()` then uses `read()` as today. A file shorter than `from` gives null. `confirm()` passes offset 0 to `promptAfter` and adds `from` to `prompt.at`, so `settle`'s `promptAt < s.offset` check (`:290`) still uses whole-file bytes.
  - After `UNCONFIRMED_MS` (`:21`), poll every `CONFIRM_SLOW_MS = 10_000`.
  - Add `live(): { handles: ReadonlySet<string>; at: number } | null` to `PressDeps`. The worker keeps `at` as the clock time when the list call started. `confirm()` returns, with the label left at `sending`, when a list with `at > label.at` does not hold the terminal. A list from before the press stops nothing: the terminal can be new.
- Why the earlier audits no longer block this: they kept the 1 s poll and the terminal check out, because a late `turnId` left the answer open (`docs/sending-hotfix-plan.md:39`, `:49`). Since 0.4.3, `settle` in the tracker closes an answer whose press got its `turnId` during the model call (`src/turns.ts:238-242`), and `confirm()` closes one whose turn already drained (`src/presses.ts:285-293`).
- Tests in `src/presses.test.ts`:
  - `confirm reads from the press offset on a Claude transcript`: `readTail` gets `label.from`, and `read` gets no call.
  - `after 10 minutes confirm reads every 10 seconds`: from minute 11 to 12, at most 6 reads.
  - `a prompt seen in the slow phase after its turn drained still closes the answer` (repro b of `docs/confirm-race-plan.md:27`, at minute 11).
  - `confirm stops when a list taken after the press does not hold the terminal`: no reads after it, and the stored state is still `sending`.
  - `a list taken before the press that does not hold the terminal stops nothing`.

## R8. The turn poll reads new bytes, and reads a Codex rollout once

- Files: `src/turns.ts` (`TrackerDeps`, `poll` `:320-346`), `src/worker.ts` (tracker deps `:316-328`).
- Fault: each 1 s poll for up to `LIMIT_MS` after a `done` (`src/turns.ts:51`) reads the whole file (`:331`). For Codex it then reads it again in `codexTurn` (`src/worker.ts:321-323`).
- Change:
  - Claude: when `promptsBefore(s)` is known (`:178-183`), read with `readTail(sessionId, readFrom(s))`, call `readTurn(tail, 0, prompts)`, and add `readFrom(s)` to `nextOffset`. When it is not known, read the whole file as today.
  - Codex: `codexTurn(sessionId, offset, bytes)` takes the bytes `poll` already read. No result cache: `readFrom(s)` moves after each `enqueue` with no file growth (`src/turns.ts:177-178`, `:343`), so each tick reads the turn at the current offset.
  - `size` and `grewAt` (`:326-336`) use `readFrom(s) + tail.length` for Claude.
- Tests in `src/turns.test.ts`, written first (gate):
  - `three completed turns in an unchanged rollout are all queued`: Codex, one `done`, and the file does not grow after it. All three turns are queued in order.
  - The same test for a Claude transcript.
  - `the poll reads a Claude transcript from the session offset`: a fake `readTail` sees `readFrom(s)`, and the queued turn's `nextOffset` equals the one a whole-file read gives.
  - `a Codex poll reads the rollout once per tick`.
  - The existing poll and queue tests pass unchanged.

## R9. Plans of evicted sessions are dropped

- Files: `src/worker.ts` (`plans` `:272`, `listTerminals` `:303-312`).
- Fault: `plans` holds one plan per session read (`:293`) and no code deletes from it. A session that `save()` evicts keeps its plan in memory.
- Change: after each list, `plans` drops sessions not in `tracker.state().sessions`.
- Cut after the 2026-11-19 audit (items 3–4): pruning `codexLaunches`, `launchGenerations`, `statuses` and `paneTerminals` (`:124`, `:126`, `:299-300`). A launch can still wait to be tracked when a newer list omits its terminal (`:135-178`), and safe pruning needs launch-state tracking. The panel maps (`src/panel.tsx:37-50`) are cut too: snoozed rows and rows missing from `agents.list` leave the view without being deleted (`src/panel.tsx:83-99`), so view membership cannot decide what to drop. These maps hold small values per terminal or row.
- Test in `src/worker.test.ts`: `an evicted session's plan is dropped at the next list`.

## R10. Remove dead and repeated code, and record why the CLI stays

- Files: `src/transcript.ts` (`:6`, `:178-181`), `src/worker.ts` (`:86-89`, `:303`, `:460`, `:686`), `src/socket.ts` (`:93`, `:100-102`), `src/state.ts` (`:117`).
- Change:
  - Delete `readTurnFile` (`src/transcript.ts:179`); no code calls it. Delete the `readFileSync` import (`:6`) that only it uses.
  - Move the comment at `src/worker.ts:86-89` to `untaggedReason` (`:105`); it now sits above `holds`.
  - Export `HANDLE` from `src/socket.ts:93` and use it at `src/worker.ts:460`.
  - Export `isObject` from `src/state.ts:117`; `src/socket.ts` imports it and drops its copy (`:100-102`).
  - A comment at `listTerminals` (`:303`): host `terminal.list` needs a `workspaceId` and lists at most 50 terminals (`.orca/types/orca-host/index.d.ts:224-229`), so the CLI's one global list stays.
  - A comment at the `worktree create` call (`:686`): host `workspace.create` has no parent-worktree option (`.orca/types/orca-host/index.d.ts:242-247`), so the CLI stays.
- Test: the gate. No behavior changes.

## R11. Release 0.4.6

- Files: `package.json`, `package-lock.json` (two places), `orca-plugin.json`, as in 763e076. `docs/live-check.md`: a new section `## Review fixes (0.4.6) — pending` at the end, in the 0.4.5 form (`docs/live-check.md:189-195`).
- `engines.orca` stays `>=1.4.248`: no task uses a newer host method.
- Commit: `Release 0.4.6: failed saves undo their row, timeouts may have saved, and polls read less`, with a short body as in 763e076.
- Live check rows:
  - A record call during a slow save says "may have been saved", and a repeat call gives "Already open."
  - Press an option in a terminal, then close the terminal. The plugin log shows no more confirm reads for it after the next list (60 s).
  - Activity Monitor: the worker's CPU at rest with 5 or more agents stays near 0 %.

---

## Dropped

- **Bug 2, request id and idempotent record.** The ledger already does not save a repeat (`src/core/ledger.ts:836`, `src/core/tools.ts:129,168,214`). R2 keeps only the message change.
- **Bug 4, panel reload before the undo.** No reload can see the state before the undo. `save` registers `changed` (`src/turns.ts:219`) before `edit` registers the undo (`src/turns.ts:488`) on the same promise, so both run in one microtask checkpoint. The panel's `inbox.view` arrives later as a new message and first awaits `ready` (`src/worker.ts:528-529`).
- **Runtime shape checks for host replies** (`src/worker.ts:334,530,614`). Not cheap enough to earn their place: R4 types the calls.
- **`src/panel.tsx:133-134` stray comment.** It is a provenance note for `clip` (the inbox repo's `clipLabel`), not a stray comment.
- **11, host terminal list.** Host `terminal.list` lists one workspace and at most 50 terminals (`.orca/types/orca-host/index.d.ts:224-229`). A global list needs one call per workspace from `workspace.list` (`:164-169`), and `runOrca` stays for hand-off. It adds code. R10 records why.
- **12, host `workspace.create` for Hand off.** Its params have no parent worktree (`.orca/types/orca-host/index.d.ts:242-247`). The Orca 1.4.261 handler (`/Applications/Orca.app/Contents/Resources/app.asar`, `"workspace.create"`) builds its create request from `repo`, `name`, `baseBranch` and `setup` only. The CLI call (`src/worker.ts:686-689`) stays. R10 records why.
- **13, `sessionId` from Orca for launch tagging.** The launch hook must stay: `tagLaunch` adds the MCP tools and the prompt hook to the command (`src/worker.ts:149`, `:184`). `sessionId` comes only on a status event (`.orca/types/orca-host/index.d.ts:315`), after the prompt hook binds the session (`src/socket.ts:163`). It removes no code.
- **Engines bump to `>=1.4.259`.** With 11–13 dropped, no task needs it.

`.orca/types/...` line numbers are from `orca plugin types .` with Orca 1.4.261 on 2026-11-19.

## Risks

- R7 reverses two earlier audit decisions (the 1 s poll and no terminal stop). The case for it rests on the 0.4.3 closes (`src/turns.ts:238-242`, `src/presses.ts:285-293`). Run `/audit-plan` on R7 before it is built.
- R4's CI step depends on a typings generator in the Orca checkout. If `ORCA_REF` must move, the validator moves with it and can flag new manifest rules.
- R7 and R8 tail reads trust that `label.from` and the session offset are byte offsets into the same file. A transcript that is replaced by a shorter file gives null and falls back to whole reads; R7 and R8 test that fallback only through the "unknown prompts" path.
- R5 delays every panel reload by up to 250 ms, the press path included. `press()` in the panel calls `load()` itself (`src/panel.tsx:132`), so a press shows its own label at once.
- R1's undo save can fail too. Then storage keeps the failed row until the next save that succeeds; a retry gets "Already open.", not a second row.

## Out of scope

- `find()` scans every project folder when a Claude session has no saved transcript (`src/worker.ts:234-240`). `learn()` saves the path at the first hit (`:243-247`), so the scan runs once per session.
- The repeated Codex rollout parse (R6, cut) and the worker and panel map pruning (R9, cut).
- The 10 type errors in `src/panel.tsx` and 38 in `src/worker.test.ts` under the Orca typings.

<!-- Audit findings are added below by /audit-plan. -->
