# Agent Inbox for Orca — spec

An Orca plugin that adds an inbox icon to Orca's right sidebar. The panel shows what each agent in the focused workspace waits on you for: open questions and tasks. It replaces the inbox skill when you work in Orca, so you have one sidebar, not two.

## Decisions

| Question | Decision |
|---|---|
| Where it shows | A new icon in Orca's right sidebar. The panel is the inbox's "Now" tab only. Files and PRs stay out: Orca's sidebar has its own. |
| Who does the work | The plugin, alone. It needs no inbox mod, Codex plugin or MCP server. |
| Which agents | Claude Code only in version 1. Codex in version 2. |
| How items arrive | The inbox model only. The agent does not call `record` or `close`. The launch hook only tags each agent with a session id. |
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
   - The workspace path comes from `workspace.list`, never from parsing `workspaceId`.
3. **Build the exchange.** An adapter for the Claude Code transcript format turns the new part of the transcript into the `Exchange` that `buildPrompt` (`hooks/model-text.ts:246`) and `applyExchangeUpdate` (`hooks/ledger.ts:605`) take:
   - `person`: the prompt text. `trigger` when there is no prompt.
   - `activity`: one line for each tool call, and each dialog (`AskUserQuestion`) with its outcome.
   - `reply`: the agent's final text.
   - `screen`: the rows that the panel showed for this agent when the turn started.
   - `turn`: the count of prompts in the session.
   - `press`: the last press the plugin sent to this terminal, if the turn is the answer to it.
   - The build plan tests the adapter against real saved transcripts before any panel work.
4. **Run the inbox model.** The plugin runs `claude -p --model sonnet --no-session-persistence --strict-mcp-config --setting-sources ""` with `systemText` and `buildPrompt`, then applies the answer with `applyExchangeUpdate`. One run per terminal at a time; a turn that ends during a run waits for it.
5. **Draw the panel.** The panel shows one section per tracked agent in the focused workspace, newest activity first. Each section has its questions and tasks, as in the Now tab.
6. **Act on a press.** Each press shows its result on its row at once, as the inbox's press rules say.
   - Answer or choose an option: the plugin sends the answer with `terminal:send` only when that terminal's `mainAgent.state` is `done`, so the agent waits at its prompt. The states `working`, `blocked` (a permission dialog) and `waiting` hold the answer. The row reads "Sending…" until the transcript shows the answer as a new prompt, then "✓ Answered". A held answer reads "Waits for the agent" with a Copy button. If no new prompt shows within 10 seconds, the row reads, in red, "Not delivered" with Copy.
   - Done or dismiss: the plugin closes the row in its own state. Nothing goes to the agent.

## State

- The plugin keeps one ledger per agent session in Orca's plugin storage (`storage:own`), keyed by the session file's id.
- Saved state outlives the code: the state has a `version` field and an upgrade function from day one.

## Access the plugin asks for

`agent:read`, `terminal:send`, `storage:own`, `workspace:read`, and the `agent.launch.before` hook. Its README says that the hook adds a session id to each new `claude` session and changes nothing else. It also says what each is for, and that the plugin runs `claude -p` on your account after each agent turn.

## Out of scope for version 1

- `record` and `close` tools for the agent. The launch hook can add them later.
- Files, PRs and the session plan.
- Agents on SSH or WSL hosts.
- Agents other than Claude Code. Codex comes in version 2: it has no session id flag, and Orca reserves `ORCA_*` env names, so it needs its own matching rule (see `review-ledger.md`, rounds 2 and 3).

## Risks to settle in the build plan

1. **Cost and speed.** One Sonnet call per turn. The plan must measure the time from `done` to the row showing.
2. **The inbox model in a sidebar with many agents.** The panel can grow long. The plan must check it with three agents open.
3. **Licensing.** The copied code comes from the inbox repo. The new repo keeps its license and says where the code came from.

## Done means

- In a real Orca window with two agents in one workspace, a question that an agent asks shows in the correct section within 15 seconds of the turn's end.
- Answering it in the panel types the answer into the correct terminal.
- `orca plugin check .` and the plugin's own tests pass.
