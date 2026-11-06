# Agent Inbox for Orca

An Orca plugin that adds an inbox icon to Orca's right sidebar. The panel shows what each agent in the focused workspace waits on you for. It mirrors the "Now" tab of the inbox skill for Claude Code:

- **Questions** the agent asked you, with its options and its recommendation. Press an option to type the answer into that agent's terminal.
- **Tasks** that only you can do, such as a sign-in or a review.
- **Findings**: Issues and Opportunities the agent noticed outside its task, with Fix (or Do it), File issue, Reply and Dismiss.
- **The session plan**: the agent's plan file, as "PLAN N of M steps" with one collapsible line per task.

The panel has one section per tracked agent, newest activity first.

## Claude Code only

Version 1 tracks Claude Code. Codex support is coming. A Codex agent in the workspace gets a short section that says so.

## Install and develop

The plugin is not in a catalog yet. Load it from a clone:

```sh
orca plugin dev load .        # load this folder as a development plugin
orca plugin dev watch .       # or load it, then stream its logs and reloads
orca plugin validate .
orca plugin check .           # renders the panel in each src/panel.check.ts scenario
npm test                      # runs orca plugin test .
npm run typecheck
```

Loading grants the plugin its access, so read the manifest and the sections below first. The plugin has a worker (`src/worker.ts`) and a panel (`src/panel.tsx`). `src/protocol.ts` types the requests between them. Orca transpiles both files when they load, so there is no build step.

## What the plugin asks for

| Access | What the plugin does with it |
|---|---|
| `agent.launch.before` hook | Tags each new `claude` launch so the plugin knows its session (see below). It passes every other launch through unchanged. |
| `agent.status.changed` event | Learns when an agent's turn ends (`done`), so it reads the turn from the transcript. |
| `agent:read` | Lists the agents in the focused workspace, to draw a section for each one and to count the agents it does not track. |
| `terminal:send` | Types your answer, reply or hand-off into the agent's terminal when you press a button. It sends only when the agent waits at its prompt. |
| `storage:own` | Keeps one ledger (questions, tasks, findings, press labels) per agent session in the plugin's own storage. |
| `workspace:read` | Unused. The plugin finds each transcript by its session id, so it needs no workspace list. A later version drops it. |

## What it adds to each tracked `claude` launch

The launch hook inserts these flags right after `claude` and changes nothing else in the command. Your own flags, and a prompt at the end, stay as they were.

- `--session-id <new uuid>`: gives the session a known id. A `--resume <uuid>` launch keeps its own id.
- `--mcp-config <json>`: adds one MCP server, `orca-inbox`, with the tools `record` and `close`. It adds to your own MCP servers and does not replace them.
- `--append-system-prompt <text>`: the inbox guidance, which tells the agent when to record a question, a task or a finding, and when to close one.
- `--settings <json>`: a `UserPromptSubmit` hook. Before each prompt, it prints the open items with their close ids and the plan-file note, so the agent sees the inbox state beside your message. Your own hooks still run.

If the launch already sets `--mcp-config`, `--strict-mcp-config`, `--append-system-prompt` or `--settings`, the plugin tracks the session but adds no tools, and the panel says "No tools" for that agent.

The MCP server (`bin/mcp-server.mjs`) and the prompt hook (`bin/prompt-hook.mjs`) are thin clients. They pass each call to the worker over a local Unix socket, `orca-agent-inbox-<uid>/worker.sock` in the system temp folder, with mode 0600 in a folder only your user can open. The worker is the only writer.

## It runs `claude -p` on your account

After each tracked turn ends, the worker reads the new part of the transcript and runs the inbox model on it, to catch a question or task the agent asked in its reply but did not record:

```
claude -p --model sonnet --effort low --no-session-persistence --strict-mcp-config --setting-sources "" --tools ""
```

This is one Sonnet call per turn, on your own Claude account and its usage. The call loads none of your settings, tools or MCP servers, and saves no session. After three failed runs on one turn, the panel shows "N turns not read".

## What it does not track

- A session started outside Orca's agent launcher, such as `claude` typed into a plain shell. The panel shows how many such agents it sees as "N agents not tracked".
- A restored session, `--continue`, `--resume` with a name or no id, and `--fork-session`.
- A terminal after `/clear` starts a new session file, until the next launch.
- Agents on SSH or WSL hosts.
- Files and PRs: Orca's sidebar has its own.

## Credits

The ledger, the model text, the tools and the plan code are copied from [anthony-fp/inbox](https://github.com/anthony-fp/inbox), a fork of [petekp/inbox](https://github.com/petekp/inbox), the original inbox for Claude Code, under its MIT license. `NOTICE.md` lists each copied file and its changes.
