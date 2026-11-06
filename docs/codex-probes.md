# Codex probes (T14)

Run on 2026-11-05 in a scratch folder outside the repo, on the Codex home Orca gives an account (`<orca data>/codex-accounts/<id>/home`). Codex 0.164.0, then 0.166.0 (the TUI updated itself during probe 6). No session content is recorded here.

| # | Probe | Result |
|---|---|---|
| 1 | `notify` from `-c notify=[script]` under `codex exec` | Runs at each turn end. The script gets `ORCA_PANE_KEY` and `CODEX_HOME` in its env, and one JSON argument: `type` (`agent-turn-complete`), `thread-id`, `turn-id`, `cwd`, `client`, `input-messages`, `last-assistant-message`. |
| 2 | Thread id to rollout | `threads.rollout_path` in `$CODEX_HOME/state_5.sqlite`, keyed by `threads.id`. |
| 3 | Pane key | Orca's own Codex hook reports `paneKey=${ORCA_PANE_KEY}` (`~/.orca/agent-hooks/codex-hook.sh:81`), the value `agent.status.changed` reports as `paneKey`. |
| 4 | `mcp_servers.<name>.env_vars=["ORCA_PANE_KEY"]` | Passes it. The tools also need `mcp_servers.<name>.default_tools_approval_mode="approve"`, or Codex refuses the call when approval is off. |
| 5 | Thread from inside the MCP server (audit fix 1) | Each `tools/call` carries `params._meta.threadId`, `params._meta.sessionId` and `params._meta["x-codex-turn-metadata"]` with `thread_id`, `turn_id` and `thread_source` (`user` for the main thread). The parent `codex` process also holds the rollout open (`lsof -p <ppid>`). The plugin uses `_meta`. |
| 6 | C1: `UserPromptSubmit` hook from `-c hooks.UserPromptSubmit=[{hooks=[{type="command",command=…}]}]` | Under `codex exec`: does not run (untrusted). In the TUI: Codex shows "Hooks need review: 1 hook is new or changed", with "Trust all and continue". After trust, the hook runs at each prompt with `session_id`, `turn_id`, `transcript_path`, `cwd` and `prompt` on stdin and `ORCA_PANE_KEY` in its env, and its stdout reaches the model. Codex saves the trust as `hooks.state."/<session-flags>/config.toml:user_prompt_submit:0:0"` with a hash of the hook, so a stable command is trusted once per Codex account. The plugin never writes this trust itself. |
| 7 | C2: the launch hook's `agent` | Orca's agent ids include `claude` and `codex`; the hook gets `agent: launchAgent` (`codex`). Orca does not hook a launch that resumes a saved session (`resumeOrigin`/`resumeProviderSession` set), as the host API says. |
| 8 | C3: sub-agent threads | Not run live. Tool calls carry `thread_source`; the prompt hook from a sub-agent carries `agent_id` (inbox repo `codex/src/hook.ts:80`); `threads.source` is `{"subagent":…}` for one. The plugin keeps only `thread_source: user`, no `agent_id`. T21 checks one live. |

What changes in the design:
- The prompt hook binds the pane to its thread at every prompt, before any tool runs, once the person trusts it. Tool calls bind it too, from `_meta`. `notify` binds it at turn end, with no trust needed. Any one is enough.
- Without trust, the agent gets no open items or close ids before its prompt, as risk C1 said. The panel says "Trust the Agent Inbox hook in Codex" on that agent's section until a prompt hook call arrives.
