// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('passes an agent launch through unchanged', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  const launch = {
    agent: 'claude',
    workspaceId: 'ws-1',
    workspaceKind: null,
    terminalId: 'term-1',
    command: 'claude',
    env: {}
  }
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', launch), {
    kind: 'continue',
    event: launch
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('logs an agent status change and does nothing else', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.emit('agent.status.changed', {
    workspaceId: 'ws-1',
    paneKey: 'pane-1',
    state: 'done',
    receivedAt: 1
  })
  assert.deepEqual(worker.logs, ['agent.status.changed pane-1 done'])
  assert.deepEqual(worker.posts, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
