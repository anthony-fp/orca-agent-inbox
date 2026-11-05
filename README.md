# Agent Inbox

An Orca plugin that collects the questions and tasks your Claude Code agents leave in one right-sidebar panel. Work in progress: see `docs/spec.md` and `docs/plan.md`.

The plugin has a worker (`src/worker.ts`) and a panel (`src/panel.tsx`). `src/protocol.ts` types the requests between them. Orca transpiles both files when they load, so there is no build step.

## Develop

```sh
orca plugin validate .
orca plugin check .   # renders the panel in each src/panel.check.ts scenario
npm test              # runs orca plugin test .
```

`orca plugin dev watch .` loads this folder into Orca. Loading grants the plugin its access, so read the manifest first.
