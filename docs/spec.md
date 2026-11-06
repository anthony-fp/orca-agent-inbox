# Agent Inbox for Orca — spec

An Orca plugin that adds an inbox icon to Orca's right sidebar. The panel shows what each agent in the focused workspace waits on you for: open questions and tasks. It replaces the inbox skill when you work in Orca, so you have one sidebar, not two.

## Decisions

| Question | Decision |
|---|---|
| Where it shows | A new icon in Orca's right sidebar. The panel is the inbox's "Now" tab: questions, tasks, findings and the session plan with collapsible tasks. Files and PRs stay out: Orca's sidebar has its own. |
| Who does the work | The plugin, alone. It needs no inbox mod, Codex plugin or MCP server. |
| Which agents | Claude Code in version 1. Codex in version 2: see "Codex (version 2)". |
| How items arrive | Two ways, as in the inbox skill: the agent calls `record` and `close` and sees the open items beside each prompt, and the inbox model reads each finished turn. The launch hook adds the tools and the guidance to each tracked `claude` launch. |
| Findings | Shown as in the inbox skill: Issues and Opportunities sections in the panel. A finding may show at once or at the end of the turn; it does not need to be instant. |
| Shared code | Copied once from the inbox repo. This repo owns the copy from then on. |

## What Orca gives a plugin (tested on Orca 1.4.248)

- A `trusted-worker` has full Node: it reads files, runs commands and fetches over the network.
- `agent.status.changed` fires on each `working` → `done` change, with `workspaceId`, `terminalId`, `paneKey` and `title`. It does not carry the reply text or the agent's session id.
- The worker can list the agents in the focused workspace. It cannot tell which terminal has focus.
- `terminal:send` lets the plugin type into an agent's terminal.
- A prompt a person types is never hooked, so the plugin cannot add text to it.

## How it works

1. **Tag each launch.** The `agent.launch.before` hook (no capability needed) gives each agent a known session id:
   - Claude Code, new session: add `--session-id <new uuid>`.
   - Claude Code, `--resume <uuid>` with no `--fork-session`: keep that uuid. Every other resume form is not tracked: `--continue`, `--resume` with a name or no argument, and any `--fork-session`. The plugin never changes the flags a person chose, beyond adding `--session-id` to a new session.
   - Any other agent, Codex included, is not tracked in version 1. The hook passes its launch through unchanged.
   - The plugin saves `terminalId → { agent, sessionId }`.
   - **An agent the plugin did not see launch has no section.** That covers a restored session and a `claude` typed into a plain shell. The panel says how many agents it does not track. It never guesses a match.
   - When a Claude Code `/clear` starts a new session file in the same terminal, the terminal stops being tracked until the next launch. The panel shows it as not tracked.
2. **A turn ends.** The plugin acts on `agent.status.changed` only when all of these hold:
   - `terminalId` is present and has a saved session.
   - `mainAgent.state` is `done`. The combined `state` also counts child agents, so the plugin does not use it. On an older Orca with no `mainAgent`, the plugin uses `state`.
   - An `interruption` or `unconfirmed` outcome still gets processed, because the transcript is the record of what happened.
   - The `done` marks the terminal's turn as pending in storage. The plugin then reads the transcript once a second for up to 15 seconds. A turn is complete when the transcript has a reply after the last prompt and the file has not grown for 2 seconds. Only a complete turn moves the saved offset forward. A turn still pending after 15 seconds stays pending and is read again at the next `done` or when the plugin starts. When a later prompt appears after a pending turn that has no reply, the plugin stores that turn as `incomplete`, sends it to the inbox model with an empty reply, and moves the offset to the later prompt. One turn with no reply never blocks the turns after it. A repeated `done` with no new transcript text does nothing.
   - The transcript is found by the session id alone: `~/.claude/projects/*/<sessionId>.jsonl`. The found path is saved on the session. Before the file exists (it shows after the first prompt), the turn is pending and the next `done` looks again. The launch's `workspaceId` (`<repoId>::<path>`) does not match the ids `workspace.list` gives (`identity:<key>`), so no workspace id is used (docs/live-check.md).
   - The session's folder, for its plan file, is the first `cwd` in its transcript, or the prompt hook's `cwd` before the transcript exists. It is saved on the session.
3. **Build the exchange.** An adapter for the Claude Code transcript format turns the new part of the transcript into the `Exchange` that `buildPrompt` (`hooks/model-text.ts:246`) and `applyExchangeUpdate` (`hooks/ledger.ts:605`) take:
   - `person`: the prompt text. `trigger` when there is no prompt.
   - `activity`: one line for each tool call, and each dialog (`AskUserQuestion`) with its outcome.
   - `reply`: the agent's final text.
   - `screen`: the rows that the panel showed for this agent when the turn started.
   - `turn`: the count of prompts in the session.
   - `press`: the last press the plugin sent to this terminal, if the turn is the answer to it.
   - The build plan tests the adapter against real saved transcripts before any panel work.
4. **Run the inbox model.** The plugin runs `claude -p --model sonnet --no-session-persistence --strict-mcp-config --setting-sources ""` with `systemText` and `buildPrompt`, then applies the answer with `applyExchangeUpdate`. One run per terminal at a time; a turn that ends during a run waits for it.
5. **Draw the panel.** The panel shows one section per tracked agent in the focused workspace, newest activity first. Each section has its questions and tasks, as in the Now tab. An agent that is not Claude Code, such as Codex, gets a short section with its title and "Agent Inbox supports Claude Code only for now. Codex support is coming soon."
6. **Act on a press.** Each press shows its result on its row at once, as the inbox's press rules say.
   - Answer or choose an option: the plugin sends the answer with `terminal:send` only when that terminal's `mainAgent.state` is `done`, so the agent waits at its prompt. The states `working`, `blocked` (a permission dialog) and `waiting` hold the answer. The row reads "Sending…" until the transcript shows the answer as a new prompt, then "✓ Answered". A held answer reads "Waits for the agent" with a Copy button. If no new prompt shows within 10 seconds, the row reads, in red, "Not delivered" with Copy.
   - Done or dismiss: the plugin closes the row in its own state. Nothing goes to the agent.

## The agent's tools (findings)

1. **The launch hook adds the tools and the inbox text.** For a tracked `claude` launch, the hook also adds:
   - `--mcp-config <json>` for one MCP server named `orca-inbox` with `record` and `close`. The name is not `inbox`, so it never meets the inbox skill's server.
   - `--append-system-prompt <guidanceText(ORCA)>`.
   - `--settings <json>` with a `UserPromptSubmit` hook. Its command asks the worker for `inboxText(ORCA, ledger, …)` and `closedText` and prints them, so the agent sees the open items and their close ids beside each prompt, as the inbox skill shows them. This is how the agent learns ids; there is no `show` tool (the inbox repo's `show` adds a file to the Files tab, `hooks/files.ts:11-23`, and is out of scope).
   - If the command already has `--mcp-config`, `--strict-mcp-config`, `--append-system-prompt` or `--settings`, the launch is tagged but gets no tools, and the panel says so for that agent.
2. **The MCP server and the prompt hook are thin clients.** Each is one Node script in the plugin folder, with no state. The MCP server offers `record` and `close` with the descriptions and schemas from `agentTools` (inbox repo `hooks/tools.ts:80-87`). Each sends its call to the worker over a local socket and returns the worker's answer. The socket path and the session id come in their arguments. If the worker does not answer within 5 seconds, the tool answers that the inbox is not available, and the prompt hook prints nothing.
3. **The worker is the only writer.** For each call it runs the copied `recordItem` or `recordClose` on that session's ledger, saves the state, and returns the tool's answer unchanged. `record` answers "Recorded" with no id, as in the skill (`hooks/tools.ts:108-141`): the id reaches the agent in the inbox text beside its next prompt. The socket is a file with mode 0600 in a 0700 folder in the system temp dir (`src/socket.ts:24`): an installed plugin's folder can be read-only, and a long path can pass the 104-byte socket limit.
4. **One ordering path per session.** The worker applies tool calls at once, in the order they arrive. It never waits for a model run. A model run's update is applied to the ledger as it is at commit time (`src/turns.ts:132`), so tool calls that land during a run are kept. Each tool call is stamped with the session's active turn. The `UserPromptSubmit` hook sets it: before it asks for the inbox text, it sends a `prompt-start` message, and the worker raises the session's active turn by 1 and saves it, before it answers. So a call made during turn N carries N, including the first prompt and a prompt sent while an earlier model run is still out. The model run for turn N keeps using N for its own update. Tests: a call during the first turn, a call during a slow model run, a call after turn N commits but before turn N+1 starts, a prompt sent while a run is out, a worker restart between a call and the next turn.
5. **The `ORCA` host gets real tool names:** `recordTool` `mcp__orca-inbox__record`, `closeTool` `mcp__orca-inbox__close`, and an `intro` that names the Orca panel. `systemText` reads only `band`, so the inbox model's text does not change.
6. **Text a model reads.** The guidance, the tool descriptions and the tool answers are the inbox's, word for word, with only the host names changed. Before they ship, run the inbox repo's agent eval (`./scripts/eval.sh --suite agent`) with the `ORCA` host and compare with `CLAUDE_CODE`.
7. **The panel** adds "Issues · N" and "Opportunities · N" after Tasks, with the inbox's finding rows and buttons, less the actions that version 1 leaves out.

## The session plan

As in the inbox skill, with the skill's own code from the inbox repo's `hooks/plan.ts` (`parsePlan`, `planPath`, `planNote`, `planLines`), copied word for word.

1. **The agent learns its plan file.** The `UserPromptSubmit` hook from "The agent's tools" also prints `planNote(planPath(<workspace path>, <sessionId>), plan)`: the skill's "your plan file for this session is …" text, with the steps in progress. It is text a model reads, so the agent eval covers it.
2. **The worker reads the plan file** at `<workspace path>/.inbox/plans/<sessionId>.md` with `parsePlan` at the end of each turn and when the file changes. `## ` headings are tasks; `- [ ]`, `- [~]` and `- [x]` lines are steps.
3. **The panel draws it** after Issues and Opportunities, in each agent's section: "PLAN N of M steps" with the progress bar, then one line per task with its count. Each task heading is collapsible: a task with a `[~]` step is open by default, every other task is closed. A press toggles it, and the panel keeps the choice while it runs. Steps show ✓ done, ◐ in progress, ○ waiting, as `planLines` gives them.
4. **The plan file is the agent's.** The plugin only reads it. It never writes or deletes it.

## Codex (version 2)

Codex has no session id flag, and the plugin cannot add an `ORCA_*` env name. Orca gives each Codex process `ORCA_PANE_KEY`, and reports the same value as `paneKey` in `agent.status.changed` (`~/.orca/agent-hooks/codex-hook.sh:81`). Codex's `notify` program gets that env and the thread id. So the plugin matches each Codex pane to its rollout exactly, with no time guess. Probe on Codex 0.164.0, 2026-11-05: one `codex exec` turn with `-c notify=[script]` gave the script `ORCA_PANE_KEY`, `CODEX_HOME`, and `{"type":"agent-turn-complete","thread-id","turn-id","cwd","last-assistant-message"}`.

1. **The launch hook adds `-c` flags** to a `codex` launch. It changes nothing else.
   - `notify=["node","<plugin>/bin/codex-notify.mjs","<socket>"]`.
   - `mcp_servers.orca-inbox.command` and `.args` for the same `bin/mcp-server.mjs` as Claude, with `mcp_servers.orca-inbox.env_vars=["ORCA_PANE_KEY"]`, because Codex gives an MCP server only a short list of env names.
   - `developer_instructions=<guidanceText(ORCA_CODEX)>`. `ORCA_CODEX` is the `ORCA` host with Codex's tool names.
   - A prompt hook that prints `inboxText` and the plan note before each prompt, as for Claude. Risk C1 says how.
   - If the command already sets `notify`, `mcp_servers.orca-inbox` or `developer_instructions`, the launch is not tracked, and the panel says so for that agent.
2. **`bin/codex-notify.mjs` is a thin client.** It sends `{ paneKey, codexHome, payload }` to the worker over the socket and exits. It then runs the `notify` from `$CODEX_HOME/config.toml`, if one is set, with the same payload, so a person's own `notify` still runs. It never waits more than 5 seconds for the worker.
3. **The worker ties the pane to the thread.** It saves `paneKey → { agent: "codex", threadId, codexHome }`. It finds the rollout with `rolloutFor(codexHome, threadId)` (inbox repo `codex/src/transcript.ts:85`). A `codex resume` gives its thread id in the same way, so resumes are tracked too. A new thread id in the same pane, as after `/new`, replaces the old one.
4. **A turn ends** at the `notify` call or the `done` event, whichever comes second. The same pending rules as Claude apply (step 2 of "How it works"). The adapter is the inbox repo's Codex code, `turnIn` and `readRollout` (`codex/src/transcript.ts:198`, `:423`), copied word for word.
5. **The inbox model for a Codex turn is `codex exec`**, run as the inbox repo runs it (`codex/src/update.ts:110-135`): `--ephemeral --ignore-user-config --ignore-rules -s read-only`, the model in `MODEL`, low effort, `systemText` as `model_instructions_file`. It runs with that pane's `CODEX_HOME`, so it uses the same account. A Codex-only user needs no Claude sign-in. Claude Code turns keep `claude -p`.
6. **Tool calls** from Codex carry `ORCA_PANE_KEY`, not a session id. The worker finds the session from the pane. A call before the first `notify` waits up to 5 seconds for it, then answers that the inbox is not available.
7. **The panel and presses** do not change. A press sends its text with `terminal:send` when `mainAgent.state` is `done`, as for Claude. "✓ Answered" shows when the rollout has the answer as a new prompt.

Codex risks, each probed first in the build plan:

- **C1. The prompt hook.** Find out whether Codex 0.164.0 takes a `UserPromptSubmit` hook from `-c`, and whether it asks for trust. If it does not, the agent gets its close ids from the `record` and `close` answers and the guidance only. Say which in the README.
- **C2. The `agent` value.** Find the `agent` string that `agent.launch.before` gives for Codex, and how the command looks (`codex`, a path, or a wrapper).
- **C3. Sub-agent threads.** Find out whether `notify` fires for a guardian or sub-agent thread, and keep only the pane's main thread.
- **C4. The eval.** Run the inbox repo's agent eval with `ORCA_CODEX` on Codex, as for Claude, and the model eval for `codex exec`.

## State

- The plugin keeps one ledger per agent session in Orca's plugin storage (`storage:own`), keyed by the session file's id.
- Saved state outlives the code: the state has a `version` field and an upgrade function from day one.

## Access the plugin asks for

`agent:read`, `terminal:send`, `storage:own`, `workspace:read`, and the `agent.launch.before` hook. Its README says that the hook adds a session id to each new `claude` session and changes nothing else. It also says what each is for, and that the plugin runs `claude -p` on your account after each agent turn. For Codex, it says that the hook adds `-c` flags for `notify`, the `orca-inbox` tools and the guidance, and that the plugin runs `codex exec` on that Codex account after each turn.

## Out of scope for version 1

- Files and PRs.
- Agents on SSH or WSL hosts.
- Agents other than Claude Code and Codex. Codex comes in version 2 ("Codex (version 2)"). It replaces the time-based rule in `review-ledger.md`, rounds 2 and 3.

## Risks to settle in the build plan

1. **Cost and speed.** One Sonnet call per turn. The plan must measure the time from `done` to the row showing.
2. **The inbox model in a sidebar with many agents.** The panel can grow long. The plan must check it with three agents open.
3. **Licensing.** The copied code comes from the inbox repo. The new repo keeps its license and says where the code came from.

## Done means

- In a real Orca window with two agents in one workspace, a question that an agent asks shows in the correct section within 15 seconds of the turn's end.
- Answering it in the panel types the answer into the correct terminal.
- `orca plugin check .` and the plugin's own tests pass.
