// The plugin's worker. Orca transpiles this file when it loads: no build step.
// T0 skeleton: the launch hook changes nothing, and status changes are only logged.
import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
  // Pass every agent launch through unchanged. Returning undefined continues the chain.
  orca.hooks.on('agent.launch.before', () => undefined)

  orca.events.on('agent.status.changed', (event) => {
    orca.log(`agent.status.changed ${event.paneKey} ${event.state}`)
  })
}
