# Inbox model: `CLAUDE_CODE` against `ORCA`

Task T5 of `docs/plan.md`. The plugin gives the inbox model `systemText(ORCA)` in place of the mod's `systemText(CLAUDE_CODE)`. This page records the comparison that the inbox repo's `AGENTS.md` ("Text a model reads") asks for before such a change is kept.

## What changed in the text

`systemText` reads one `Host` field, `band`. `ORCA.band` is `null`, so `systemText(ORCA)` is `systemText(CLAUDE_CODE)` without one sentence: "They always see how many items are in <open> and <findings> in a band above their prompt." The rest is word for word. The other `ORCA` fields (`surface`, `findingsIn`, empty tool names and `intro`) feed only texts the plugin does not send.

## The call

Run on 2026-11-05 with Claude Code 2.1.318, from a temporary folder as the working directory:

```
CLAUDE_CODE_MAX_OUTPUT_TOKENS=1600 claude -p --model sonnet --effort low --no-session-persistence \
  --strict-mcp-config --setting-sources "" --tools "" --system-prompt <systemText(host)>
```

The prompt is `buildPrompt(ledger, exchange)` on stdin. `runInboxModel` in `src/model.ts` kills the run at 45 s and parses the answer with `parseReply`, as the mod does.

Every flag above is in `claude --help` for 2.1.318. Differences from the mod's `$.model.complete` call:

- **Output cap.** The CLI has no flag for it. The env var `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1600` sets the cap. Over the cap, the CLI fails the run ("API Error: Claude's response exceeded the … output token maximum", exit 1), where the mod gets the cut-off text. The plugin treats it as a failed run. No run in this comparison came near the cap.
- **No prompt cache.** The mod marks the system text `cache: true`. The CLI gives no control over that.

## Exchanges

Five hand-written exchanges, with invented content. Each ran 5 times per host, 3 runs at a time.

| # | Exchange | Ledger before |
|---|---|---|
| 1 | Reply asks the person to choose per IP or per API key for rate limits | empty |
| 2 | Reply asks the person to run `npx wrangler login` | empty |
| 3 | Person answers the open question ("In-memory map is fine"), reply says it is done | one open question |
| 4 | A rename that finished, nothing waits on the person | empty |
| 5 | Activity has an `AskUserQuestion` dialog the person dismissed | empty |

## Counts

Items added and closed in each run, as "added/closed".

| # | `CLAUDE_CODE` runs | `ORCA` runs | Match within 1 |
|---|---|---|---|
| 1 | 1/0 ×5 | 1/0 ×5 | yes |
| 2 | 1/0 ×5 | 1/0 ×5 | yes |
| 3 | 0/1 ×4, 1 timeout | 0/1 ×5 | yes |
| 4 | 0/0 ×5 | 0/0 ×5 | yes |
| 5 | 1/0 ×5 | 1/0 ×5 | yes |

The adds and closes were also the same items: exchange 3 closed the open question with "In-memory map" in every answered run, and exchange 5 added "Which Node versions should CI test?" with the same options and recommendation in every run.

## Time

| | Median | Slowest |
|---|---|---|
| `CLAUDE_CODE` | 4.4 s | 45 s (timeout) |
| `ORCA` | 4.3 s | 20.7 s |
| All 50 runs | 4.3 s | 45 s (timeout) |

Four runs took 11 to 22 s, and one hit the 45 s cap with no answer. The tail is long, so the turn tracker (T4) must expect a run that fails on time and keep the turn pending for a retry (spec risk 1).

## Verdict

Keep `ORCA`. The counts match on every exchange, and the one timeout was in a `CLAUDE_CODE` run.
