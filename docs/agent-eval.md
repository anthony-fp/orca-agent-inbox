# Agent eval (T13)

Date: 2026-11-05. Claude Code 2.1.318, model `claude-opus-5-5`. Plugin commit `d08d93f` (the text a model reads is the same as at `566d728`, where the run started: only `src/presses.ts` changed, and not its message text). Inbox commit `272b367`, in a temporary copy with the changes below.

## What ran

`./scripts/eval.sh --suite agent --agent claude`, 5 runs per case, once with `--host claude-code` and once with `--host orca`.

Changes in the temporary copy of the inbox:

- `hooks/model-text.ts`: the `ORCA` host, copied from `src/core/model-text.ts`.
- `evals/agent.ts`: a `--host` option. With `orca`, the stand-in server is named `orca-inbox`, so the tools are `mcp__orca-inbox__record` and `mcp__orca-inbox__close`. The guidance `guidanceText(ORCA)` goes in `--append-system-prompt`, as `src/launch.ts` does. The inbox notes go one per paragraph with the plan note last, as `src/socket.ts` does. No card carry and no `show`.
- `evals/probe.ts`: the `ORCA` host for the tool descriptions and answers, no guidance in `close`'s description and no `show` for that host. A case can now give a fixed answer for a tool (`answers`).
- `evals/agent-cases.json`: the new case `record-not-available`. `record` answers "The inbox is not available, so this was not saved." The agent must call `record` for the question, ask it in the reply (Redis, a `?`), not claim the question was saved or recorded, and show no ids.

The plugin has no `show` tool and carries no card, so `show-server-url`, `show-not-for-write` and `carry-card-answers-where-we-are` do not run with `ORCA`.

## Results

Results files (kept out of the repo): `claude-code-1.json` and `orca-1.json`. Both: every run graded, none stopped, exit 0. Pass bar: 75% of runs.

| Case | CLAUDE_CODE | ORCA |
|---|---|---|
| no-finding-own-change | 5 of 5 | 5 of 5 |
| no-finding-own-check | 5 of 5 | 4 of 5 |
| no-finding-progress | 4 of 5 | 4 of 5 |
| no-finding-user-only | 5 of 5 | 5 of 5 |
| finding-out-of-scope-bug | 5 of 5 | 5 of 5 |
| finding-workaround | 5 of 5 | 5 of 5 |
| finding-cannot-verify | 5 of 5 | 5 of 5 |
| record-question | 5 of 5 | 5 of 5 |
| record-task | 5 of 5 | 5 of 5 |
| reply-never-shows-ids | 5 of 5 | 5 of 5 |
| close-answered | 5 of 5 | 5 of 5 |
| close-answered-says-answer | 5 of 5 | 5 of 5 |
| close-already-closed | 5 of 5 | 5 of 5 |
| close-done-finding | 5 of 5 | 5 of 5 |
| close-no-self-answer | 5 of 5 | 5 of 5 |
| record-after-own-close | 5 of 5 | 5 of 5 |
| carry-card-answers-where-we-are | 5 of 5 | not run |
| no-task-for-own-step | 5 of 5 | 5 of 5 |
| pivot-moots-recorded-question | 5 of 5 | 5 of 5 |
| pivot-moots-recorded-task | 4 of 5 | 5 of 5 |
| user-did-it-closes-question | 5 of 5 | 4 of 5 |
| implied-answer-closes-question | 5 of 5 | 5 of 5 |
| side-request-leaves-question-open | 5 of 5 | 5 of 5 |
| plan-written-for-steps | 5 of 5 | 5 of 5 |
| plan-not-for-question | 5 of 5 | 5 of 5 |
| plan-continued-after-compaction | 5 of 5 | 5 of 5 |
| show-server-url | 5 of 5 | not run |
| show-not-for-write | 5 of 5 | not run |
| record-not-available (new) | 5 of 5 | 5 of 5 |

The failed runs, one each: `no-finding-own-check` (ORCA) recorded a finding for its own untested change; `no-finding-progress` (both) left out "memoiz" from the reply; `pivot-moots-recorded-task` (CLAUDE_CODE) and `user-did-it-closes-question` (ORCA) put an id in the reply.

New case: in all 5 ORCA runs the agent called `record`, got the "not available" answer, asked the question in the reply and said that the question was not saved to the inbox.

## Verdict

`ORCA` passes every case that `CLAUDE_CODE` passes and runs. No case blocks T8.

Not covered: the finding press messages (`src/presses.ts`) have no case in the agent suite. They are copied from the inbox's `messages.finding`, less Explain and Discuss.

## Follow-up

- No agent case covers the finding press messages (Fix, File issue, Reply on a finding) in `src/presses.ts:106-114`. They are copied word for word from the inbox, but untested here. The failure it would catch: an agent that does not act on a Fix hand-off sent from the Orca panel.

# Agent eval for Codex (T20)

Date: 2026-11-05. Codex 0.166.0, model requested `gpt-6.1-sol` (Codex does not report which model answered). Plugin commit `c6cd080`. Inbox commit `aed5f52`, in a temporary copy with these changes: `hooks/model-text.ts` gains the `ORCA` and `ORCA_CODEX` hosts, copied from `src/core/model-text.ts`; `evals/agent.ts` and `evals/probe.ts` gain `--host`, and with `orca-codex` the stand-in server is `orca-inbox` and the agent gets `guidanceText(ORCA_CODEX)` as `developer_instructions`, as `src/launch.ts:129` passes it; `evals/agent-cases.json` gains `record-not-available`.

Ran `./scripts/eval.sh --suite agent --agent codex`, 5 runs per case, once with `--host orca-codex` and once with the default Codex host. Both: 23 of 23 cases pass, every run graded, exit 0. With `--host orca-codex` every case passed 5 of 5. With the default host, `record-not-available` passed 4 of 5 (the bar is 75%). Results files: `eval-orca-codex.json` and `eval-codex.json`, kept outside the repo.

`ORCA_CODEX` passes every case that the default Codex host passes, so T21 is not blocked.
