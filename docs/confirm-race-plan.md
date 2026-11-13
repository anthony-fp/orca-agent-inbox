# Plan: 0.4.3 confirm/drain race and a deadline for `confirm()`

> **⚠️ ADVERSARIAL AUDIT (Codex, 2026-11-13) — HIGH. Do not ship unchanged: C3 makes rollback silently discard durable hand-off receipts.**
>
> `setLabel` keeps an existing hand-off receipt on later replies (`src/presses.ts:266-268`), so a reply on a handed-off item can become `unconfirmed` while it carries that receipt. An older build rejects the whole label (`src/state.ts:139`) and saves its removal under the same schema version. That removes the 'Handed off already' guard (`src/worker.ts:628`) and allows a second worktree launch for work already handed off. No C1/C2 double-close or ordering gap was found.
>
> **Redesign required before build:**
> 1. **Add no new persisted label state.** The stored state stays `sending`. `rowLabel` (`src/presses.ts:203-204`) shows "Sent, not confirmed" when a `sending` label is older than 10 minutes. The 24 h stop leaves the stored state at `sending`, so an older build reads it as it does today. Test: an old `sending` label that carries a hand-off receipt keeps the receipt and shows "Sent, not confirmed".
>
> **Status:** BLOCKED on fix 1.
>
> **---- revised 2026-11-13: C3 keeps `sending`; label derived in rowLabel ----**
>
> **---- refresh 2026-11-13 (Codex re-audit) — APPROVE. ~~Fix 1~~ resolved (`src/state.ts:128,139-151`, `src/presses.ts:266-268`). No new high findings in C1–C4. ----**
>
> **Status:** Not blocked. Build C1–C4 after hotfix H4 ([sending-hotfix-plan.md](sending-hotfix-plan.md)).

Branch: `anthony-fp/fix-stuck-sending-items`. Build after the 0.4.2 tasks in [sending-hotfix-plan.md](sending-hotfix-plan.md) ship.

Gate after every task: `npm test`, `npm run typecheck` and `orca plugin validate .` pass. A failing gate blocks the next task. Each task is one commit.

## Problem

`drain` closes an answered question only if the press carries the turn's `turnId` when the turn starts (`src/turns.ts:173-176`). `confirm()` sets that `turnId` when it sees the prompt (`src/presses.ts:291-292`). When `confirm()` sees the prompt late, the question stays open, with the label "✓ <option>":

- **a.** `confirm()` matches while `drain` awaits the model (`src/turns.ts:180`). The commit (`src/turns.ts:183-184`) does not look at `pressFor` again.
- **b.** `confirm()` matches after the turn drained. No code reads that `turnId` again.

The `confirm()` loop ends only on a match, or on `done` plus 10 s (`src/presses.ts:290-300`). A status that is never `done` keeps the label at "Sending…" with no end.

Repro: `src/zz-confirm-race.test.ts` (kept in the session scratchpad). It uses a model that waits on a gate, and a `confirm()` read that can be made blind. All three tests fail on today's code:

- a: `question still open; label=✓ Drop bell for now (recommended)`
- b: `question still open; label=✓ Drop bell for now (recommended)`
- c: `label after 11 min: Sending…`

Each task copies its repro test into `src/presses.test.ts`.

---

## C1. Drain looks for the press again when it commits (case a)

- Files: `src/turns.ts` (`settle` `:145-155`, `drain` `:173-198`).
- Change: in `settle`, run `pressFor(cur, turn.turnId)` again on the session as it is now. If an `answer` press carries that `turnId` and its row is still in `ledger.items`, close the row as `answered` with the press's answer, as `:174-175` does. This covers the `ok` commit (`:183-184`) and the `MAX_FAILURES` commit (`:193`).
- Guards: the press must carry this turn's `turnId`, and the row id must still be open. An older press on the same row has no such `turnId`, so it closes nothing.
- Test: repro a. After the model returns, the question is closed as `answered` with outcome `Drop bell for now (recommended)`.

## C2. `confirm()` closes the answer when its turn has already drained (case b)

- Files: `src/transcript.ts` (`promptAfter` `:184-188`), `src/core/codex-transcript.ts` (`codexPromptAfter` `:525-534`), `src/presses.ts` (`settle` `:274-280`, `confirm` `:284-303`).
- Change: both matchers also return the prompt's byte position (`at` from `lines()`, `src/transcript.ts:44-47`; the turn start, `src/core/codex-transcript.ts:526`). When `confirm()` matches an `answer` whose position is before the session's `offset`, the turn has drained. `settle` then sets `answered` and `turnId`, and closes the row with `closeItem` (already imported, `src/presses.ts:9`), as `drain` does.
- Guards: keep `settle`'s check `cur.at === at && isOpenRow(...)` (`src/presses.ts:277-278`).
- Why this does not overlap C1: `offset` moves past a turn only in the same synchronous `update` as the commit (`src/turns.ts:145-150`). A prompt before `offset` is drained (C2 closes it). A prompt at or after `offset` is not drained yet (C1 or the start check closes it).
- Test: repro b. After `confirm()` sets `turnId`, the question is closed as `answered`.

## C3. "Sent, not confirmed" after 10 minutes, from the label's age; the loop ends at 24 h

- Files: `src/presses.ts` (`rowLabel` `:200-211`, `labelledRows` `:215-226`, `confirm` `:284-303`). No change to `src/state.ts`.
- No new stored state. The stored label stays `sending`.
- `rowLabel(label, now = 0)`: a `sending` label with `now - label.at >= 10 min` reads `Sent, not confirmed` (muted), with Copy. `labelledRows` already takes `now` (`:215`) and passes it on. With the default `now = 0`, the other callers (`:336`, `:349`, `:354`, `src/worker.ts:663`) read as today.
- A running hand-off stays "Handing off…": `rowLabel` checks the `handoff` kind first (`:201`).
- In `confirm()`:
  - The poll stays at 1 s (`src/presses.ts:19`), and a match still sets `answered` and `turnId`.
  - At `label.at + 24 h`, return. The stored label stays `sending`, so it reads `Sent, not confirmed`.
  - The `done` + 10 s rule stays (`src/presses.ts:292-298`).
- There is no stop when a terminal is absent, and no slower poll. Earlier audit rounds rejected both.
- The next worker start: `upgradeLabel` turns a saved `sending` into `undelivered` ("Not delivered") and keeps its hand-off receipt (`src/state.ts:137-141`, `:150-151`). Every label whose watch ended at a restart is treated this way today, and a restarted worker has no watch for it. The 24 h stop adds no new case.
- Tests:
  - Repro c: after 11 minutes the label reads `Sent, not confirmed`, and the stored state is still `sending`. After 25 h, `confirm()` makes no more reads.
  - Receipt: a reply press on a handed-off task carries the receipt (`setLabel`, `src/presses.ts:266-268`). After 11 minutes the row reads `Sent, not confirmed`, and `presses[id].handoff` is unchanged. After a restart (`upgradeState`), the receipt is still there, and `inbox.handoff` still returns 'Handed off already' (`src/worker.ts:628`).
  - The status stays `working` for 11 minutes, then the queued prompt shows. The label becomes `✓ <option>`, and the question closes after the turn. Pattern: `src/presses.test.ts:164-173`.

## C4. Release 0.4.3 and check it live

- Files: `package.json`, `package-lock.json` (two places), `orca-plugin.json`, as in d52241d. `docs/live-check.md`: a new section `## Confirm race (0.4.3) — <date>`.
- Commits: `Release 0.4.3: answered questions close, and a send that never shows ends`, then `Record the 0.4.3 live check`.
- Live check:
  - Press an option while the agent works on a long turn. The row reads "✓ <option>", and the question closes after that turn.
  - Press an option in a terminal whose agent waits at a permission prompt for more than 10 minutes. The row reads "Sent, not confirmed".

---

## Out of scope

- Liveness checks and storage size: see `sending-hotfix-plan.md`.
- Matching prompts by text in `drain`. An earlier audit rejected it, because it does not respect `label.from`.

<!-- Audit findings are added below by /audit-plan. -->
