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
